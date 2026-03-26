import { describe, it, expect, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import { StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node.js';
import { LspProxy } from '../src/proxy.js';
import { createRequest, createNotification } from '../src/types.js';
import type { ServerConfig } from '../src/types.js';

const MOCK_SERVER = join(import.meta.dirname!, 'helpers', 'mock-server.ts');

const mockServerConfig: ServerConfig = {
  command: process.execPath,
  args: ['--import', 'tsx', MOCK_SERVER],
  languages: { typescript: ['.ts'] },
  transport: 'stdio',
};

interface RestartPolicy {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/** Create an in-process proxy wired to PassThrough streams. */
const createTestProxy = (
  config: ServerConfig = mockServerConfig,
  restartPolicy?: RestartPolicy,
) => {
  const clientToProxy = new PassThrough();
  const proxyToClient = new PassThrough();

  const proxy = new LspProxy('mock', config, {
    input: clientToProxy,
    output: proxyToClient,
    restartPolicy: { maxRetries: 3, baseDelayMs: 50, maxDelayMs: 200, ...restartPolicy },
  });

  const writer = new StreamMessageWriter(clientToProxy);
  const reader = new StreamMessageReader(proxyToClient);

  return { proxy, writer, reader, clientToProxy, proxyToClient };
};

/** Collect all messages from a reader until a predicate matches. */
const waitForMessage = (
  reader: StreamMessageReader,
  predicate: (msg: any) => boolean,
  timeoutMs = 10_000,
): Promise<any> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Timeout waiting for message')),
      timeoutMs,
    );
    const disposable = reader.listen((msg: any) => {
      if (predicate(msg)) {
        clearTimeout(timer);
        disposable.dispose();
        resolve(msg);
      }
    });
  });

/** Send a request and wait for the matching response. */
const request = (
  writer: StreamMessageWriter,
  reader: StreamMessageReader,
  id: number,
  method: string,
  params?: object,
): Promise<any> => {
  const promise = waitForMessage(reader, (msg) => msg.id === id && !msg.method);
  writer.write(createRequest(id, method, params));
  return promise;
};

/** Send a notification (fire and forget). */
const notify = (writer: StreamMessageWriter, method: string, params?: object): void => {
  writer.write(createNotification(method, params));
};

/** Perform the full initialize handshake. */
const initializeProxy = async (
  writer: StreamMessageWriter,
  reader: StreamMessageReader,
) => {
  const res = await request(writer, reader, 0, 'initialize', {
    processId: process.pid,
    rootUri: null,
    capabilities: {},
  });
  notify(writer, 'initialized', {});
  return res;
};

describe('LspProxy integration', () => {
  let proxy: LspProxy;
  let writer: StreamMessageWriter;
  let reader: StreamMessageReader;

  afterEach(() => proxy.dispose());

  it('completes initialize handshake', async () => {
    ({ proxy, writer, reader } = createTestProxy());
    proxy.start();

    const res = await initializeProxy(writer, reader);
    expect(res.result.capabilities.hoverProvider).toBe(true);
  });

  it('forwards requests to child server', async () => {
    ({ proxy, writer, reader } = createTestProxy());
    proxy.start();
    await initializeProxy(writer, reader);

    notify(writer, 'textDocument/didOpen', {
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

    expect(hover.result.echo).toBe('textDocument/hover');
  });

  it('handles shutdown/exit gracefully', async () => {
    ({ proxy, writer, reader } = createTestProxy());
    proxy.start();
    await initializeProxy(writer, reader);

    const shutdownRes = await request(writer, reader, 99, 'shutdown');
    expect(shutdownRes.result).toBeNull();
  });

  describe('restart behavior', () => {
    /** Crash via request — the error response confirms crash detection completed. */
    const crashAndWait = (w: StreamMessageWriter, r: StreamMessageReader, id: number) =>
      request(w, r, id, '$/crash');

    it('restarts after crash and flushes buffered requests', async () => {
      ({ proxy, writer, reader } = createTestProxy());
      proxy.start();
      await initializeProxy(writer, reader);

      // Crash as request — error response confirms proxy entered restarting state
      const crashRes = await crashAndWait(writer, reader, 19);
      expect(crashRes.error).toBeDefined();

      // This request arrives during restart — buffered until restart completes
      const hover = await request(writer, reader, 20, 'textDocument/hover', {
        textDocument: { uri: 'file:///test.ts' },
        position: { line: 0, character: 0 },
      });
      expect(hover.result.echo).toBe('textDocument/hover');
    });

    it('replays tracked documents to restarted server', async () => {
      ({ proxy, writer, reader } = createTestProxy());
      proxy.start();
      await initializeProxy(writer, reader);

      // Open a document before crash
      notify(writer, 'textDocument/didOpen', {
        textDocument: {
          uri: 'file:///replayed.ts',
          languageId: 'typescript',
          version: 1,
          text: 'const x = 1;',
        },
      });

      // Crash and wait for restart to begin
      const crashRes = await crashAndWait(writer, reader, 25);
      expect(crashRes.error).toBeDefined();

      // After restart completes, ask the new server what documents it has
      const docsRes = await request(writer, reader, 26, '$/documents');
      expect(docsRes.result).toEqual([
        { uri: 'file:///replayed.ts', languageId: 'typescript', version: 1 },
      ]);
    });

    it('errors pending requests on crash', async () => {
      ({ proxy, writer, reader } = createTestProxy());
      proxy.start();
      await initializeProxy(writer, reader);

      // Send $/crash as a request — server exits without responding
      const res = await crashAndWait(writer, reader, 30);
      expect(res.error).toBeDefined();
      expect(res.error.message).toContain('crashed');
    });

    it('stops if server crashes before initial handshake', async () => {
      const exitingConfig: ServerConfig = {
        command: process.execPath,
        args: ['-e', 'process.exit(1)'],
        languages: { typescript: ['.ts'] },
        transport: 'stdio',
      };
      ({ proxy, writer, reader } = createTestProxy(exitingConfig));
      proxy.start();

      const res = await request(writer, reader, 0, 'initialize', {
        processId: process.pid,
        rootUri: null,
        capabilities: {},
      });
      expect(res.error).toBeDefined();
    });

    it('stops after max retries exhausted', async () => {
      ({ proxy, writer, reader } = createTestProxy(mockServerConfig, { maxRetries: 0 }));
      proxy.start();
      await initializeProxy(writer, reader);

      // Crash with a pending request — gets error response
      const crashRes = await crashAndWait(writer, reader, 40);
      expect(crashRes.error).toBeDefined();

      // maxRetries=0 → proxy should be stopped, not restarting
      const res = await request(writer, reader, 41, 'textDocument/hover', {
        textDocument: { uri: 'file:///test.ts' },
        position: { line: 0, character: 0 },
      });
      expect(res.error).toBeDefined();
      expect(res.error.code).toBe(-32002); // ServerNotInitialized
    });

    it('handles shutdown during restart', async () => {
      ({ proxy, writer, reader } = createTestProxy(mockServerConfig, {
        baseDelayMs: 500,
      }));
      proxy.start();
      await initializeProxy(writer, reader);

      // Crash as request — error response confirms proxy is now restarting
      const crashRes = await crashAndWait(writer, reader, 49);
      expect(crashRes.error).toBeDefined();

      // Send shutdown while restarting (before 500ms restart delay)
      const res = await request(writer, reader, 50, 'shutdown');
      expect(res.result).toBeNull();

      // Proxy should now be stopped
      const hover = await request(writer, reader, 51, 'textDocument/hover', {});
      expect(hover.error).toBeDefined();
      expect(hover.error.code).toBe(-32002);
    });

    it('cancels buffered request during restart', async () => {
      ({ proxy, writer, reader } = createTestProxy());
      proxy.start();
      await initializeProxy(writer, reader);

      // Crash and wait
      const crashRes = await crashAndWait(writer, reader, 59);
      expect(crashRes.error).toBeDefined();

      // Buffer a request during restart, then cancel it
      const hoverPromise = request(writer, reader, 60, 'textDocument/hover', {
        textDocument: { uri: 'file:///test.ts' },
        position: { line: 0, character: 0 },
      });
      notify(writer, '$/cancelRequest', { id: 60 });

      const res = await hoverPromise;
      expect(res.error).toBeDefined();
      expect(res.error.code).toBe(-32800); // RequestCancelled
    });
  });
});
