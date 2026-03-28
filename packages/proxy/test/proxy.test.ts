import { writeFile, mkdir, rm } from 'node:fs/promises';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node.js';
import { LspProxy } from '../src/proxy.js';
import type { ServerConfig } from '../src/types.js';
import { Message as Msg } from '../src/types.js';
import { request, notify, waitForMessage, initializeProxy } from './helpers/test-client.js';

const MOCK_SERVER = join(import.meta.dirname, 'helpers', 'mock-server.ts');

const mockServerConfig: ServerConfig = {
  command: process.execPath,
  args: ['--import', 'tsx', MOCK_SERVER],
  languages: { typescript: ['.ts'] },
  transport: 'stdio',
};

const createTestProxy = (
  config: ServerConfig = mockServerConfig,
  restartPolicy?: Partial<{ maxRetries: number; baseDelayMs: number; maxDelayMs: number }>,
  extraOptions?: Partial<{ maxResyncBytes: number; maxPendingEvents: number }>,
) => {
  const clientToProxy = new PassThrough();
  const proxyToClient = new PassThrough();

  const proxy = new LspProxy(
    new Map([['mock', config]]),
    {
      input: clientToProxy,
      output: proxyToClient,
      restartPolicy: { maxRetries: 3, baseDelayMs: 50, maxDelayMs: 200, ...restartPolicy },
      ...extraOptions,
    },
  );

  // Polling loops (vi.waitFor) add temporary listeners; raise the limit to avoid warnings
  proxyToClient.setMaxListeners(50);

  const writer = new StreamMessageWriter(clientToProxy);
  const reader = new StreamMessageReader(proxyToClient);

  return { proxy, writer, reader, clientToProxy, proxyToClient };
};

describe('LspProxy integration', () => {
  let proxy: LspProxy;
  let writer: StreamMessageWriter;
  let reader: StreamMessageReader;

  afterEach(() => {
    proxy.dispose();
  });

  describe('lazy initialization', () => {
    it('does not spawn servers during initialize handshake', async () => {
      // If the proxy eagerly spawned, a subsequent immediate shutdown
      // would need to wait for the server process. With lazy init,
      // shutdown on a never-started server returns instantly.
      ({ proxy, writer, reader } = createTestProxy());
      void proxy.start();
      await initializeProxy(writer, reader);

      // Shutdown without opening any files — no server was spawned
      const res = await request(writer, reader, 99, 'shutdown');
      expect(res).toMatchObject({ result: null });
    });

    it('starts server on first matching didOpen', async () => {
      ({ proxy, writer, reader } = createTestProxy());
      void proxy.start();
      await initializeProxy(writer, reader);

      // didOpen triggers lazy start; the subsequent request is buffered
      // then flushed after the server completes initialization
      await notify(writer, 'textDocument/didOpen', {
        textDocument: {
          uri: 'file:///lazy.ts',
          languageId: 'typescript',
          version: 1,
          text: 'const x = 1;',
        },
      });

      const hover = await request(writer, reader, 10, 'textDocument/hover', {
        textDocument: { uri: 'file:///lazy.ts' },
        position: { line: 0, character: 0 },
      });
      expect(hover).toMatchObject({ result: { echo: 'textDocument/hover' } });
    });
  });

  it('returns ServerNotInitialized for requests before initialize', async () => {
    ({ proxy, writer, reader } = createTestProxy());
    void proxy.start();

    const res = await request(writer, reader, 1, 'textDocument/hover', {
      textDocument: { uri: 'file:///test.ts' },
      position: { line: 0, character: 0 },
    });
    expect(res).toMatchObject({ error: { code: -32002 } });
  });

  it('returns ServerNotInitialized for requests after shutdown', async () => {
    ({ proxy, writer, reader } = createTestProxy());
    void proxy.start();
    await initializeProxy(writer, reader);

    await request(writer, reader, 98, 'shutdown');

    const res = await request(writer, reader, 99, 'textDocument/hover', {});
    expect(res).toMatchObject({ error: { code: -32002 } });
  });

  it('completes initialize handshake', async () => {
    ({ proxy, writer, reader } = createTestProxy());
    void proxy.start();

    const res = await initializeProxy(writer, reader);
    expect(res).toMatchObject({ result: { capabilities: { hoverProvider: true } } });
  });

  it('forwards requests to child server', async () => {
    ({ proxy, writer, reader } = createTestProxy());
    void proxy.start();
    await initializeProxy(writer, reader);

    await notify(writer, 'textDocument/didOpen', {
      textDocument: {
        uri: 'file:///test.ts',
        languageId: 'typescript',
        version: 1,
        text: 'const x = 1;',
      },
    });

    const hover = await request(writer, reader, 10, 'textDocument/hover', {
      textDocument: { uri: 'file:///test.ts' },
      position: { line: 0, character: 6 },
    });

    expect(hover).toMatchObject({ result: { echo: 'textDocument/hover' } });
  });

  it('handles shutdown/exit gracefully', async () => {
    ({ proxy, writer, reader } = createTestProxy());
    void proxy.start();
    await initializeProxy(writer, reader);

    const shutdownRes = await request(writer, reader, 99, 'shutdown');
    expect(shutdownRes).toMatchObject({ result: null });
  });

  it('preserves existing client capabilities when injecting dynamicRegistration', async () => {
    ({ proxy, writer, reader } = createTestProxy());
    void proxy.start();

    await request(writer, reader, 0, 'initialize', {
      processId: process.pid,
      rootUri: null,
      capabilities: {
        workspace: { applyEdit: true },
        textDocument: { hover: { contentFormat: ['markdown'] } },
      },
    });
    await notify(writer, 'initialized', {});

    const res = await request(writer, reader, 5, '$/initParams');
    expect(res).toMatchObject({
      result: {
        capabilities: {
          workspace: {
            applyEdit: true,
            didChangeWatchedFiles: { dynamicRegistration: true },
          },
          textDocument: { hover: { contentFormat: ['markdown'] } },
        },
      },
    });
  });

  it('injects dynamicRegistration for didChangeWatchedFiles into server init params', async () => {
    ({ proxy, writer, reader } = createTestProxy());
    void proxy.start();
    await initializeProxy(writer, reader);

    // Query the mock server for the init params it received
    const res = await request(writer, reader, 5, '$/initParams');
    expect(res).toMatchObject({
      result: {
        capabilities: {
          workspace: {
            didChangeWatchedFiles: { dynamicRegistration: true },
          },
        },
      },
    });
  });

  it('always advertises textDocumentSync Full (1) regardless of server capability', async () => {
    ({ proxy, writer, reader } = createTestProxy());
    void proxy.start();

    // The mock server advertises textDocumentSync: 1, but even if it advertised
    // 2 (Incremental), the proxy must override to 1 (Full) because resync
    // replaces document content, making incremental client edits unsafe.
    const res = await initializeProxy(writer, reader);
    expect(res).toMatchObject({
      result: { capabilities: { textDocumentSync: 1 } },
    });
  });

  describe('restart behavior', () => {
    const crashAndWait = (w: StreamMessageWriter, r: StreamMessageReader, id: number) =>
      request(w, r, id, '$/crash');

    it('restarts after crash and flushes buffered requests', async () => {
      ({ proxy, writer, reader } = createTestProxy());
      void proxy.start();
      await initializeProxy(writer, reader);

      const crashRes = await crashAndWait(writer, reader, 19);
      expect(crashRes).toMatchObject({ error: expect.objectContaining({}) as unknown });

      const hover = await request(writer, reader, 20, 'textDocument/hover', {
        textDocument: { uri: 'file:///test.ts' },
        position: { line: 0, character: 0 },
      });
      expect(hover).toMatchObject({ result: { echo: 'textDocument/hover' } });
    });

    it('replays tracked documents to restarted server', async () => {
      ({ proxy, writer, reader } = createTestProxy());
      void proxy.start();
      await initializeProxy(writer, reader);

      await notify(writer, 'textDocument/didOpen', {
        textDocument: {
          uri: 'file:///replayed.ts',
          languageId: 'typescript',
          version: 1,
          text: 'const x = 1;',
        },
      });

      const crashRes = await crashAndWait(writer, reader, 25);
      expect(crashRes).toMatchObject({ error: expect.objectContaining({}) as unknown });

      const docsRes = await request(writer, reader, 26, '$/documents');
      expect(docsRes).toMatchObject({
        result: [{ uri: 'file:///replayed.ts', languageId: 'typescript', version: 1 }],
      });
    });

    it('errors pending requests on crash', async () => {
      ({ proxy, writer, reader } = createTestProxy());
      void proxy.start();
      await initializeProxy(writer, reader);

      const res = await crashAndWait(writer, reader, 30);
      expect(res).toMatchObject({ error: { message: expect.stringContaining('crashed') as unknown } });
    });

    it('stops if server crashes before initial handshake', async () => {
      const exitingConfig: ServerConfig = {
        command: process.execPath,
        args: ['-e', 'process.exit(1)'],
        languages: { typescript: ['.ts'] },
        transport: 'stdio',
      };
      ({ proxy, writer, reader } = createTestProxy(exitingConfig));
      void proxy.start();
      await initializeProxy(writer, reader);

      // First request triggers lazy start — server crashes before handshake
      const res = await request(writer, reader, 1, 'textDocument/hover', {
        textDocument: { uri: 'file:///test.ts' },
        position: { line: 0, character: 0 },
      });
      expect(res).toMatchObject({ error: expect.objectContaining({}) as unknown });
    });

    it('stops after max retries exhausted', async () => {
      ({ proxy, writer, reader } = createTestProxy(mockServerConfig, { maxRetries: 0 }));
      void proxy.start();
      await initializeProxy(writer, reader);

      const crashRes = await crashAndWait(writer, reader, 40);
      expect(crashRes).toMatchObject({ error: expect.objectContaining({}) as unknown });

      const res = await request(writer, reader, 41, 'textDocument/hover', {
        textDocument: { uri: 'file:///test.ts' },
        position: { line: 0, character: 0 },
      });
      expect(res).toMatchObject({ error: { code: -32002 } });
    });

    it('resolves start() when all servers exhaust retries', async () => {
      ({ proxy, writer, reader } = createTestProxy(mockServerConfig, { maxRetries: 0 }));
      const done = proxy.start();
      await initializeProxy(writer, reader);

      // Crash with 0 retries → server enters stopped state → proxy should auto-dispose
      await request(writer, reader, 42, '$/crash');

      // start() should resolve (not hang as a zombie)
      const timeout = new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error('zombie'));
        }, 3000);
      });
      await expect(Promise.race([done, timeout])).resolves.toBeUndefined();
    });

    it('handles shutdown during restart', async () => {
      ({ proxy, writer, reader } = createTestProxy(mockServerConfig, {
        baseDelayMs: 500,
      }));
      void proxy.start();
      await initializeProxy(writer, reader);

      const crashRes = await crashAndWait(writer, reader, 49);
      expect(crashRes).toMatchObject({ error: expect.objectContaining({}) as unknown });

      const res = await request(writer, reader, 50, 'shutdown');
      expect(res).toMatchObject({ result: null });

      const hover = await request(writer, reader, 51, 'textDocument/hover', {});
      expect(hover).toMatchObject({ error: { code: -32002 } });
    });

    it('cancels buffered request during restart', async () => {
      ({ proxy, writer, reader } = createTestProxy());
      void proxy.start();
      await initializeProxy(writer, reader);

      const crashRes = await crashAndWait(writer, reader, 59);
      expect(crashRes).toMatchObject({ error: expect.objectContaining({}) as unknown });

      const hoverPromise = request(writer, reader, 60, 'textDocument/hover', {
        textDocument: { uri: 'file:///test.ts' },
        position: { line: 0, character: 0 },
      });
      await notify(writer, '$/cancelRequest', { id: 60 });

      const res = await hoverPromise;
      expect(res).toMatchObject({ error: { code: -32800 } });
    });
  });

  describe('watcher registration', () => {
    const workspaceDir = join(import.meta.dirname, '..', 'tmp-workspace-reg');
    const workspaceUri = pathToFileURL(workspaceDir).href;

    let reqSeq = 200;

    afterEach(async () => {
      await rm(workspaceDir, { recursive: true, force: true }).catch(() => { /* ignore */ });
    });

    it('intercepts watcher registration and dispatches file events', async () => {
      await mkdir(workspaceDir, { recursive: true });

      const watcherConfig: ServerConfig = {
        ...mockServerConfig,
        args: [...mockServerConfig.args, '--register-watchers'],
      };

      ({ proxy, writer, reader } = createTestProxy(watcherConfig));
      void proxy.start();

      await initializeProxy(writer, reader, workspaceUri);

      // Wait for the proxy to process the mock server's registerCapability
      // by polling until a watcher registration is active (file event dispatch works)
      await vi.waitFor(async () => {
        // Create a probe file and check if the server receives the event
        await writeFile(join(workspaceDir, 'probe.ts'), 'probe');
        const probe = await request(writer, reader, reqSeq++, '$/watcherEvents');
        expect(probe).toMatchObject({
          result: expect.arrayContaining([expect.anything()]) as unknown,
        });
      }, { timeout: 5000, interval: 100 });

      // Write a .ts file — should trigger the registered watcher
      await writeFile(join(workspaceDir, 'new-file.ts'), 'export const x = 1;');

      await vi.waitFor(async () => {
        const res = await request(writer, reader, reqSeq++, '$/watcherEvents');
        expect(res).toMatchObject({
          result: expect.arrayContaining([
            expect.objectContaining({
              changes: expect.arrayContaining([
                expect.objectContaining({
                  uri: expect.stringContaining('new-file.ts') as unknown,
                }),
              ]) as unknown,
            }),
          ]) as unknown,
        });
      }, { timeout: 5000, interval: 100 });
    });

    it('splits mixed registration: intercepts watchers, forwards rest to client', async () => {
      await mkdir(workspaceDir, { recursive: true });

      const mixedConfig: ServerConfig = {
        ...mockServerConfig,
        args: [...mockServerConfig.args, '--register-mixed'],
      };

      ({ proxy, writer, reader } = createTestProxy(mixedConfig));
      void proxy.start();

      await request(writer, reader, 0, 'initialize', {
        processId: process.pid,
        rootUri: workspaceUri,
        capabilities: {},
      });
      await notify(writer, 'initialized', {});

      // Listen for forwarded registration BEFORE triggering lazy start
      const forwardedPromise = waitForMessage(
        reader,
        msg => Msg.isRequest(msg) && msg.method === 'client/registerCapability',
      );

      // didOpen triggers lazy start — server sends registerCapability on initialized
      await notify(writer, 'textDocument/didOpen', {
        textDocument: { uri: 'file:///trigger.ts', languageId: 'typescript', version: 1, text: '' },
      });

      // Verify only the non-watcher registration was forwarded
      const forwarded = await forwardedPromise;
      expect(forwarded).toMatchObject({
        method: 'client/registerCapability',
        params: {
          registrations: [
            expect.objectContaining({ method: 'textDocument/didSave' }),
          ],
        },
      });

      // Verify the watcher registration still works
      await writeFile(join(workspaceDir, 'mixed-test.ts'), 'export const x = 1;');

      await vi.waitFor(async () => {
        const res = await request(writer, reader, reqSeq++, '$/watcherEvents');
        expect(res).toMatchObject({
          result: expect.arrayContaining([
            expect.objectContaining({
              changes: expect.arrayContaining([
                expect.objectContaining({
                  uri: expect.stringContaining('mixed-test.ts') as unknown,
                }),
              ]) as unknown,
            }),
          ]) as unknown,
        });
      }, { timeout: 5000, interval: 100 });
    });
  });

  describe('watcher cleanup on restart', () => {
    const workspaceDir = join(import.meta.dirname, '..', 'tmp-workspace-restart-watch');
    const workspaceUri = pathToFileURL(workspaceDir).href;

    let reqSeq = 600;

    afterEach(async () => {
      await rm(workspaceDir, { recursive: true, force: true }).catch(() => { /* ignore */ });
    });

    it('clears watcher registrations on crash and re-registers after restart', async () => {
      await mkdir(workspaceDir, { recursive: true });

      const watcherConfig: ServerConfig = {
        ...mockServerConfig,
        args: [...mockServerConfig.args, '--register-watchers'],
      };

      ({ proxy, writer, reader } = createTestProxy(watcherConfig));
      void proxy.start();

      await initializeProxy(writer, reader, workspaceUri);

      // Wait for initial watcher registration
      await vi.waitFor(async () => {
        await writeFile(join(workspaceDir, 'probe.ts'), 'probe');
        const res = await request(writer, reader, reqSeq++, '$/watcherEvents');
        expect(res).toMatchObject({
          result: expect.arrayContaining([expect.anything()]) as unknown,
        });
      }, { timeout: 5000, interval: 100 });

      // Crash the server — watcher registrations should be cleared
      const crashRes = await request(writer, reader, reqSeq++, '$/crash');
      expect(crashRes).toMatchObject({ error: expect.objectContaining({}) as unknown });

      // After restart, the server should re-register its watchers via initialized
      // and file events should work again
      await vi.waitFor(async () => {
        await writeFile(join(workspaceDir, 'after-restart.ts'), 'restarted');
        const res = await request(writer, reader, reqSeq++, '$/watcherEvents');
        expect(res).toMatchObject({
          result: expect.arrayContaining([
            expect.objectContaining({
              changes: expect.arrayContaining([
                expect.objectContaining({
                  uri: expect.stringContaining('after-restart.ts') as unknown,
                }),
              ]) as unknown,
            }),
          ]) as unknown,
        });
      }, { timeout: 5000, interval: 100 });
    });
  });

  describe('watcher unregistration', () => {
    const workspaceDir = join(import.meta.dirname, '..', 'tmp-workspace-unreg');
    const workspaceUri = pathToFileURL(workspaceDir).href;

    let reqSeq = 500;

    afterEach(async () => {
      await rm(workspaceDir, { recursive: true, force: true }).catch(() => { /* ignore */ });
    });

    it('stops dispatching file events after unregistering a watcher', async () => {
      await mkdir(workspaceDir, { recursive: true });

      const config: ServerConfig = {
        ...mockServerConfig,
        args: [...mockServerConfig.args, '--register-watchers', '--unregister-on-command'],
      };

      ({ proxy, writer, reader } = createTestProxy(config));
      void proxy.start();

      await initializeProxy(writer, reader, workspaceUri);

      // Wait for watcher registration to be active
      await vi.waitFor(async () => {
        await writeFile(join(workspaceDir, 'probe.ts'), 'probe');
        const res = await request(writer, reader, reqSeq++, '$/watcherEvents');
        expect(res).toMatchObject({
          result: expect.arrayContaining([expect.anything()]) as unknown,
        });
      }, { timeout: 5000, interval: 100 });

      // Snapshot baseline events
      const baseline = await request(writer, reader, reqSeq++, '$/watcherEvents');

      // Trigger unregister
      await request(writer, reader, reqSeq++, '$/unregisterWatchers');

      // Small delay to let the unregister propagate
      await new Promise<void>((r) => {
        setTimeout(r, 100);
      });

      // Write a new file — should NOT dispatch to the server
      await writeFile(join(workspaceDir, 'after-unreg.ts'), 'should not arrive');

      // Wait long enough for a flush cycle
      await new Promise<void>((r) => {
        setTimeout(r, 500);
      });

      // Verify no new events were dispatched — result should be unchanged
      const final = await request(writer, reader, reqSeq++, '$/watcherEvents');
      expect(final.result).toStrictEqual(baseline.result);
    });
  });

  describe('event backpressure', () => {
    const workspaceDir = join(import.meta.dirname, '..', 'tmp-workspace-bp');
    const workspaceUri = pathToFileURL(workspaceDir).href;

    let reqSeq = 400;

    afterEach(async () => {
      await rm(workspaceDir, { recursive: true, force: true }).catch(() => { /* ignore */ });
    });

    it('drops events exceeding maxPendingEvents cap', async () => {
      await mkdir(workspaceDir, { recursive: true });

      const watcherConfig: ServerConfig = {
        ...mockServerConfig,
        args: [...mockServerConfig.args, '--register-watchers'],
      };

      ({ proxy, writer, reader } = createTestProxy(watcherConfig, undefined, { maxPendingEvents: 2 }));
      void proxy.start();

      await initializeProxy(writer, reader, workspaceUri);

      // Wait for watcher to be active
      await vi.waitFor(async () => {
        await writeFile(join(workspaceDir, 'probe.ts'), 'probe');
        const res = await request(writer, reader, reqSeq++, '$/watcherEvents');
        expect(res).toMatchObject({
          result: expect.arrayContaining([expect.anything()]) as unknown,
        });
      }, { timeout: 5000, interval: 100 });

      // Write 4 files sequentially — with cap of 2, only the first 2 unique
      // paths get into pendingEvents before the cap blocks new entries.
      // bp-1 and bp-2 fill the cap; bp-3 and bp-4 are dropped.
      await writeFile(join(workspaceDir, 'bp-1.ts'), 'a');
      await writeFile(join(workspaceDir, 'bp-2.ts'), 'b');
      await writeFile(join(workspaceDir, 'bp-3.ts'), 'c');
      await writeFile(join(workspaceDir, 'bp-4.ts'), 'd');

      // Wait for bp-1 to appear (proves flush completed)
      await vi.waitFor(async () => {
        const res = await request(writer, reader, reqSeq++, '$/watcherEvents');
        expect(res).toMatchObject({
          result: expect.arrayContaining([
            expect.objectContaining({
              changes: expect.arrayContaining([
                expect.objectContaining({
                  uri: expect.stringContaining('bp-1.ts') as unknown,
                }),
              ]) as unknown,
            }),
          ]) as unknown,
        });
      }, { timeout: 5000, interval: 100 });

      // bp-3 and bp-4 should NOT have been dispatched (dropped by cap)
      const final = await request(writer, reader, reqSeq++, '$/watcherEvents');
      for (const dropped of ['bp-3.ts', 'bp-4.ts']) {
        expect(final).not.toMatchObject({
          result: expect.arrayContaining([
            expect.objectContaining({
              changes: expect.arrayContaining([
                expect.objectContaining({
                  uri: expect.stringContaining(dropped) as unknown,
                }),
              ]) as unknown,
            }),
          ]) as unknown,
        });
      }
    });
  });

  describe('event batching', () => {
    const workspaceDir = join(import.meta.dirname, '..', 'tmp-workspace-batch');
    const workspaceUri = pathToFileURL(workspaceDir).href;

    let reqSeq = 300;

    afterEach(async () => {
      await rm(workspaceDir, { recursive: true, force: true }).catch(() => { /* ignore */ });
    });

    it('batches multiple file changes into a single notification per server', async () => {
      await mkdir(workspaceDir, { recursive: true });

      const watcherConfig: ServerConfig = {
        ...mockServerConfig,
        args: [...mockServerConfig.args, '--register-watchers'],
      };

      ({ proxy, writer, reader } = createTestProxy(watcherConfig));
      void proxy.start();

      await initializeProxy(writer, reader, workspaceUri);

      // Wait for watcher registration to be active
      await vi.waitFor(async () => {
        await writeFile(join(workspaceDir, 'probe.ts'), 'probe');
        const res = await request(writer, reader, reqSeq++, '$/watcherEvents');
        expect(res).toMatchObject({
          result: expect.arrayContaining([expect.anything()]) as unknown,
        });
      }, { timeout: 5000, interval: 100 });

      // Write multiple files simultaneously — they should be batched into one notification
      await Promise.all([
        writeFile(join(workspaceDir, 'batch-a.ts'), 'export const a = 1;'),
        writeFile(join(workspaceDir, 'batch-b.ts'), 'export const b = 2;'),
        writeFile(join(workspaceDir, 'batch-c.ts'), 'export const c = 3;'),
      ]);

      // At least two of the batch files should appear in a single changes array
      // (proving they were batched rather than sent as separate notifications)
      await vi.waitFor(async () => {
        const res = await request(writer, reader, reqSeq++, '$/watcherEvents');
        expect(res).toMatchObject({
          result: expect.arrayContaining([
            expect.objectContaining({
              changes: expect.arrayContaining([
                expect.objectContaining({
                  uri: expect.stringContaining('batch-a.ts') as unknown,
                }),
                expect.objectContaining({
                  uri: expect.stringContaining('batch-b.ts') as unknown,
                }),
              ]) as unknown,
            }),
          ]) as unknown,
        });
      }, { timeout: 5000, interval: 100 });
    });
  });

  describe('file resync', () => {
    const workspaceDir = join(import.meta.dirname, '..', 'tmp-workspace');
    const workspaceUri = pathToFileURL(workspaceDir).href;
    const tmpFile = join(workspaceDir, 'resync-test.ts');
    const tmpUri = pathToFileURL(tmpFile).href;

    let reqSeq = 70;

    afterEach(async () => {
      await rm(workspaceDir, { recursive: true, force: true }).catch(() => { /* ignore */ });
    });

    it('resyncs document when file changes on disk', async () => {
      await mkdir(workspaceDir, { recursive: true });

      ({ proxy, writer, reader } = createTestProxy());
      void proxy.start();

      await initializeProxy(writer, reader, workspaceUri);

      await writeFile(tmpFile, 'const original = 1;');
      await notify(writer, 'textDocument/didOpen', {
        textDocument: {
          uri: tmpUri,
          languageId: 'typescript',
          version: 1,
          text: 'const original = 1;',
        },
      });

      await writeFile(tmpFile, 'const modified = 2;');

      await vi.waitFor(async () => {
        const res = await request(writer, reader, reqSeq++, '$/documents');
        expect(res).toMatchObject({
          result: expect.arrayContaining([
            expect.objectContaining({ uri: tmpUri, text: 'const modified = 2;' }),
          ]) as unknown,
        });
      }, { timeout: 5000, interval: 100 });
    });

    it('maintains monotonically increasing versions after resync', async () => {
      await mkdir(workspaceDir, { recursive: true });

      ({ proxy, writer, reader } = createTestProxy());
      void proxy.start();

      await initializeProxy(writer, reader, workspaceUri);

      // Open at version 1 → server sees v1
      await writeFile(tmpFile, 'v1');
      await notify(writer, 'textDocument/didOpen', {
        textDocument: { uri: tmpUri, languageId: 'typescript', version: 1, text: 'v1' },
      });

      // External tool writes → resync bumps to v2
      await writeFile(tmpFile, 'v1-resynced');
      await vi.waitFor(async () => {
        const res = await request(writer, reader, reqSeq++, '$/documents');
        expect(res).toMatchObject({
          result: expect.arrayContaining([
            expect.objectContaining({ uri: tmpUri, text: 'v1-resynced', version: 2 }),
          ]) as unknown,
        });
      }, { timeout: 5000, interval: 100 });

      // Client sends didChange v2 → offset makes server see v3
      await notify(writer, 'textDocument/didChange', {
        textDocument: { uri: tmpUri, version: 2 },
        contentChanges: [{ text: 'v2-from-client' }],
      });

      await vi.waitFor(async () => {
        const res = await request(writer, reader, reqSeq++, '$/documents');
        expect(res).toMatchObject({
          result: expect.arrayContaining([
            expect.objectContaining({ uri: tmpUri, text: 'v2-from-client', version: 3 }),
          ]) as unknown,
        });
      }, { timeout: 5000, interval: 100 });
    });

    it('resets version offset on close and reopen', async () => {
      await mkdir(workspaceDir, { recursive: true });

      ({ proxy, writer, reader } = createTestProxy());
      void proxy.start();

      await initializeProxy(writer, reader, workspaceUri);

      // Open at version 1
      await writeFile(tmpFile, 'original');
      await notify(writer, 'textDocument/didOpen', {
        textDocument: { uri: tmpUri, languageId: 'typescript', version: 1, text: 'original' },
      });

      // External write → resync bumps offset to 1 (server sees v2)
      await writeFile(tmpFile, 'resynced');
      await vi.waitFor(async () => {
        const res = await request(writer, reader, reqSeq++, '$/documents');
        expect(res).toMatchObject({
          result: expect.arrayContaining([
            expect.objectContaining({ uri: tmpUri, version: 2 }),
          ]) as unknown,
        });
      }, { timeout: 5000, interval: 100 });

      // Close the document — should reset offset
      await notify(writer, 'textDocument/didClose', {
        textDocument: { uri: tmpUri },
      });

      // Reopen at version 1 — server should see v1 (offset was cleared)
      await writeFile(tmpFile, 'reopened');
      await notify(writer, 'textDocument/didOpen', {
        textDocument: { uri: tmpUri, languageId: 'typescript', version: 1, text: 'reopened' },
      });

      const res = await request(writer, reader, reqSeq++, '$/documents');
      expect(res).toMatchObject({
        result: expect.arrayContaining([
          expect.objectContaining({ uri: tmpUri, version: 1, text: 'reopened' }),
        ]) as unknown,
      });
    });

    it('server receives correct version after close and reopen post-resync', async () => {
      await mkdir(workspaceDir, { recursive: true });

      ({ proxy, writer, reader } = createTestProxy());
      void proxy.start();

      await initializeProxy(writer, reader, workspaceUri);

      // Open at version 1
      await writeFile(tmpFile, 'original');
      await notify(writer, 'textDocument/didOpen', {
        textDocument: { uri: tmpUri, languageId: 'typescript', version: 1, text: 'original' },
      });

      // External write → resync bumps server version to 2 (offset=1)
      await writeFile(tmpFile, 'resynced');
      await vi.waitFor(async () => {
        const res = await request(writer, reader, reqSeq++, '$/documents');
        expect(res).toMatchObject({
          result: expect.arrayContaining([
            expect.objectContaining({ uri: tmpUri, version: 2 }),
          ]) as unknown,
        });
      }, { timeout: 5000, interval: 100 });

      // Close the document — offset should reset
      await notify(writer, 'textDocument/didClose', { textDocument: { uri: tmpUri } });

      // Reopen at version 1 — server should see v1, NOT v2
      await writeFile(tmpFile, 'reopened');
      await notify(writer, 'textDocument/didOpen', {
        textDocument: { uri: tmpUri, languageId: 'typescript', version: 1, text: 'reopened' },
      });

      // Query server directly — it should have version 1 (offset was cleared)
      const res = await request(writer, reader, reqSeq++, '$/documents');
      expect(res).toMatchObject({
        result: expect.arrayContaining([
          expect.objectContaining({ uri: tmpUri, version: 1, text: 'reopened' }),
        ]) as unknown,
      });
    });

    it('multiple resyncs produce monotonically increasing versions', async () => {
      await mkdir(workspaceDir, { recursive: true });

      ({ proxy, writer, reader } = createTestProxy());
      void proxy.start();

      await initializeProxy(writer, reader, workspaceUri);

      // Open at version 1 → server sees v1
      await writeFile(tmpFile, 'v1');
      await notify(writer, 'textDocument/didOpen', {
        textDocument: { uri: tmpUri, languageId: 'typescript', version: 1, text: 'v1' },
      });

      // First external write → resync to v2 (offset=1)
      await writeFile(tmpFile, 'disk-v2');
      await vi.waitFor(async () => {
        const res = await request(writer, reader, reqSeq++, '$/documents');
        expect(res).toMatchObject({
          result: expect.arrayContaining([
            expect.objectContaining({ uri: tmpUri, text: 'disk-v2', version: 2 }),
          ]) as unknown,
        });
      }, { timeout: 5000, interval: 100 });

      // Second external write → resync to v3 (offset=2)
      await writeFile(tmpFile, 'disk-v3');
      await vi.waitFor(async () => {
        const res = await request(writer, reader, reqSeq++, '$/documents');
        expect(res).toMatchObject({
          result: expect.arrayContaining([
            expect.objectContaining({ uri: tmpUri, text: 'disk-v3', version: 3 }),
          ]) as unknown,
        });
      }, { timeout: 5000, interval: 100 });

      // Client sends didChange v2 → offset(2) makes server see v4
      await notify(writer, 'textDocument/didChange', {
        textDocument: { uri: tmpUri, version: 2 },
        contentChanges: [{ text: 'client-v4' }],
      });

      await vi.waitFor(async () => {
        const res = await request(writer, reader, reqSeq++, '$/documents');
        expect(res).toMatchObject({
          result: expect.arrayContaining([
            expect.objectContaining({ uri: tmpUri, text: 'client-v4', version: 4 }),
          ]) as unknown,
        });
      }, { timeout: 5000, interval: 100 });
    });

    it('converges to final content after rapid successive writes', async () => {
      await mkdir(workspaceDir, { recursive: true });

      ({ proxy, writer, reader } = createTestProxy());
      void proxy.start();

      await initializeProxy(writer, reader, workspaceUri);

      // Open a file
      await writeFile(tmpFile, 'version-0');
      await notify(writer, 'textDocument/didOpen', {
        textDocument: { uri: tmpUri, languageId: 'typescript', version: 1, text: 'version-0' },
      });

      // Rapid successive writes — proxy should converge to the final content
      for (let i = 1; i <= 5; i++) {
        await writeFile(tmpFile, `version-${String(i)}`);
      }

      await vi.waitFor(async () => {
        const res = await request(writer, reader, reqSeq++, '$/documents');
        expect(res).toMatchObject({
          result: expect.arrayContaining([
            expect.objectContaining({ uri: tmpUri, text: 'version-5' }),
          ]) as unknown,
        });
      }, { timeout: 5000, interval: 100 });
    });

    it('skips resync for files exceeding maxResyncBytes', async () => {
      await mkdir(workspaceDir, { recursive: true });

      ({ proxy, writer, reader } = createTestProxy(mockServerConfig, undefined, { maxResyncBytes: 10 }));
      void proxy.start();

      await initializeProxy(writer, reader, workspaceUri);

      // Open the target file and a small "fence" file
      await writeFile(tmpFile, 'small');
      await notify(writer, 'textDocument/didOpen', {
        textDocument: { uri: tmpUri, languageId: 'typescript', version: 1, text: 'small' },
      });

      const fenceFile = join(workspaceDir, 'fence.ts');
      const fenceUri = pathToFileURL(fenceFile).href;
      await writeFile(fenceFile, 'original');
      await notify(writer, 'textDocument/didOpen', {
        textDocument: { uri: fenceUri, languageId: 'typescript', version: 1, text: 'original' },
      });

      // External write: target exceeds threshold, fence stays small
      await writeFile(tmpFile, 'x'.repeat(100));
      await writeFile(fenceFile, 'modified');

      // Wait for the fence file to be resynced — this proves the flush completed
      await vi.waitFor(async () => {
        const res = await request(writer, reader, reqSeq++, '$/documents');
        expect(res).toMatchObject({
          result: expect.arrayContaining([
            expect.objectContaining({ uri: fenceUri, text: 'modified' }),
          ]) as unknown,
        });
      }, { timeout: 5000, interval: 100 });

      // The large file should NOT have been resynced
      const res = await request(writer, reader, reqSeq++, '$/documents');
      expect(res).toMatchObject({
        result: expect.arrayContaining([
          expect.objectContaining({ uri: tmpUri, text: 'small' }),
        ]) as unknown,
      });
    });
  });
});
