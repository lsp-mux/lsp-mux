/** @module-tag slow */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, vi } from 'vitest';
import type { ExpectStatic } from 'vitest';
import type { StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node.js';
import { Message as Msg } from '../../src/types.ts';
import {
  initializeProxy,
  notify,
  openDocument,
  request,
  waitForMessage,
} from '../helpers/test-client.ts';
import {
  type ServerConfig,
  type Workspace,
  it,
  mockServerConfig,
  watcherWaitOptions,
} from './harness.ts';

/** Poll until the proxy's file watcher is active and dispatching events. */
const waitForWatcherActive = (
  expect: ExpectStatic,
  { dir, nextSeq }: Workspace,
  writer: StreamMessageWriter,
  reader: StreamMessageReader,
) =>
  vi.waitFor(async () => {
    await writeFile(path.join(dir, 'probe.ts'), 'probe');
    const probe = await request({ writer, reader }, nextSeq(), '$/watcherEvents');

    expect(probe).toMatchObject({
      result: expect.arrayContaining([expect.anything()]) as unknown,
    });
  }, watcherWaitOptions);

/** Asymmetric matcher for a single watcher change event referencing `uri`. */
const changeContaining = (expect: ExpectStatic, uri: string): unknown =>
  expect.objectContaining({ uri: expect.stringContaining(uri) as unknown }) as unknown;

/** Asymmetric matcher for a `$/watcherEvents` result carrying changes for `uris`. */
const watcherEventContaining = (expect: ExpectStatic, ...uris: string[]): unknown => {
  const changes = uris.map(uri => changeContaining(expect, uri));
  const event = expect.objectContaining({
    changes: expect.arrayContaining(changes) as unknown,
  }) as unknown;
  return expect.arrayContaining([event]) as unknown;
};

// Sequential: crash+restart test needs stable timing for watcher re-registration
describe.sequential('LspProxy file watchers', () => {
  describe('watcher registration', () => {
    it('intercepts watcher registration and dispatches file events', async ({
      createProxy,
      workspace,
      expect,
    }) => {
      const watcherConfig: ServerConfig = {
        ...mockServerConfig,
        args: [...mockServerConfig.args, '--register-watchers'],
      };

      const { writer, reader } = createProxy({ config: watcherConfig });

      await initializeProxy({ writer, reader }, workspace.uri);
      await waitForWatcherActive(expect, workspace, writer, reader);

      // Write a .ts file — should trigger the registered watcher
      await writeFile(path.join(workspace.dir, 'new-file.ts'), 'export const x = 1;');

      await vi.waitFor(async () => {
        const res = await request({ writer, reader }, workspace.nextSeq(), '$/watcherEvents');

        expect(res).toMatchObject({
          result: watcherEventContaining(expect, 'new-file.ts'),
        });
      }, watcherWaitOptions);
    });

    it('splits mixed registration: intercepts watchers, forwards rest to client', async ({
      createProxy,
      workspace,
      expect,
    }) => {
      const mixedConfig: ServerConfig = {
        ...mockServerConfig,
        args: [...mockServerConfig.args, '--register-mixed'],
      };

      const { writer, reader } = createProxy({ config: mixedConfig });

      await request({ writer, reader }, 0, 'initialize', {
        processId: process.pid,
        rootUri: workspace.uri,
        capabilities: {},
      });
      await notify(writer, 'initialized', {});

      // Listen for forwarded registration BEFORE triggering lazy start
      const forwardedPromise = waitForMessage(
        reader,
        msg => Msg.isRequest(msg) && msg.method === 'client/registerCapability',
      );

      // didOpen triggers lazy start — server sends registerCapability on initialized
      await openDocument(writer, { uri: 'file:///trigger.ts', text: '' });

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
      await writeFile(path.join(workspace.dir, 'mixed-test.ts'), 'export const x = 1;');

      await vi.waitFor(async () => {
        const res = await request({ writer, reader }, workspace.nextSeq(), '$/watcherEvents');

        expect(res).toMatchObject({
          result: watcherEventContaining(expect, 'mixed-test.ts'),
        });
      }, watcherWaitOptions);
    });
  });

  describe('watcher unregistration', () => {
    it('stops dispatching file events after unregistering a watcher', async ({
      createProxy,
      workspace,
      expect,
    }) => {
      const config: ServerConfig = {
        ...mockServerConfig,
        args: [...mockServerConfig.args, '--register-watchers', '--unregister-on-command'],
      };

      const { writer, reader } = createProxy({ config });

      await initializeProxy({ writer, reader }, workspace.uri);
      await waitForWatcherActive(expect, workspace, writer, reader);

      // Snapshot baseline events
      const baseline = await request({ writer, reader }, workspace.nextSeq(), '$/watcherEvents');

      // Trigger unregister
      await request({ writer, reader }, workspace.nextSeq(), '$/unregisterWatchers');

      // Small delay to let the unregister propagate
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 100);
      });

      // Write a new file — should NOT dispatch to the server
      await writeFile(path.join(workspace.dir, 'after-unreg.ts'), 'should not arrive');

      // Wait long enough for a flush cycle
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 500);
      });

      // Verify no new events were dispatched — result should be unchanged
      const final = await request({ writer, reader }, workspace.nextSeq(), '$/watcherEvents');

      expect(final.result).toStrictEqual(baseline.result);
    });
  });

  describe('watcher cleanup on restart', () => {
    it('clears watcher registrations on crash and re-registers after restart', async ({
      createProxy,
      workspace,
      expect,
    }) => {
      const watcherConfig: ServerConfig = {
        ...mockServerConfig,
        args: [...mockServerConfig.args, '--register-watchers'],
      };

      const { writer, reader } = createProxy({ config: watcherConfig });

      await initializeProxy({ writer, reader }, workspace.uri);
      await waitForWatcherActive(expect, workspace, writer, reader);

      // Crash the server — watcher registrations should be cleared
      const crashRes = await request({ writer, reader }, workspace.nextSeq(), '$/crash');

      expect(crashRes).toMatchObject({ error: expect.objectContaining({}) as unknown });

      // After restart, the server should re-register its watchers via initialized
      // and file events should work again
      await vi.waitFor(async () => {
        await writeFile(path.join(workspace.dir, 'after-restart.ts'), 'restarted');
        const res = await request({ writer, reader }, workspace.nextSeq(), '$/watcherEvents');

        expect(res).toMatchObject({
          result: watcherEventContaining(expect, 'after-restart.ts'),
        });
      }, watcherWaitOptions);
    });
  });

  describe('event backpressure', () => {
    it('drops events exceeding maxPendingEvents cap', async ({
      createProxy,
      workspace,
      expect,
    }) => {
      const watcherConfig: ServerConfig = {
        ...mockServerConfig,
        args: [...mockServerConfig.args, '--register-watchers'],
      };

      const { writer, reader } = createProxy({ config: watcherConfig, maxPendingEvents: 2 });

      await initializeProxy({ writer, reader }, workspace.uri);
      await waitForWatcherActive(expect, workspace, writer, reader);

      // Write 4 files sequentially — with cap of 2, only the first 2 unique
      // paths get into pendingEvents before the cap blocks new entries.
      // bp-1 and bp-2 fill the cap; bp-3 and bp-4 are dropped.
      await writeFile(path.join(workspace.dir, 'bp-1.ts'), 'a');
      await writeFile(path.join(workspace.dir, 'bp-2.ts'), 'b');
      await writeFile(path.join(workspace.dir, 'bp-3.ts'), 'c');
      await writeFile(path.join(workspace.dir, 'bp-4.ts'), 'd');

      // Wait for bp-1 to appear (proves flush completed)
      await vi.waitFor(async () => {
        const res = await request({ writer, reader }, workspace.nextSeq(), '$/watcherEvents');

        expect(res).toMatchObject({
          result: watcherEventContaining(expect, 'bp-1.ts'),
        });
      }, watcherWaitOptions);

      // bp-3 and bp-4 should NOT have been dispatched (dropped by cap)
      const final = await request({ writer, reader }, workspace.nextSeq(), '$/watcherEvents');
      for (const dropped of ['bp-3.ts', 'bp-4.ts']) {
        expect(final).not.toMatchObject({
          result: watcherEventContaining(expect, dropped),
        });
      }
    });
  });

  describe('client-native file watching', () => {
    it('forwards watcher registration to client when client supports file watching', async ({
      createProxy,
      workspace,
      expect,
    }) => {
      const watcherConfig: ServerConfig = {
        ...mockServerConfig,
        args: [...mockServerConfig.args, '--register-watchers'],
      };

      const { writer, reader } = createProxy({ config: watcherConfig });

      await request({ writer, reader }, 0, 'initialize', {
        processId: process.pid,
        rootUri: workspace.uri,
        capabilities: {
          workspace: {
            didChangeWatchedFiles: { dynamicRegistration: true },
          },
        },
      });

      // Listen for forwarded registration BEFORE triggering lazy start
      const forwardedPromise = waitForMessage(
        reader,
        msg => Msg.isRequest(msg) && msg.method === 'client/registerCapability',
      );

      await notify(writer, 'initialized', {});

      // didOpen triggers lazy start — server registers watchers on initialized
      await openDocument(writer, { uri: 'file:///trigger.ts', text: '' });

      // Watcher registration should be forwarded to client (not intercepted)
      const forwarded = await forwardedPromise;

      expect(forwarded).toMatchObject({
        method: 'client/registerCapability',
        params: {
          registrations: [
            expect.objectContaining({ method: 'workspace/didChangeWatchedFiles' }),
          ],
        },
      });
    });
  });

  describe('event batching', () => {
    it('batches multiple file changes into a single notification per server', async ({
      createProxy,
      workspace,
      expect,
    }) => {
      const watcherConfig: ServerConfig = {
        ...mockServerConfig,
        args: [...mockServerConfig.args, '--register-watchers'],
      };

      const { writer, reader } = createProxy({ config: watcherConfig });

      await initializeProxy({ writer, reader }, workspace.uri);
      await waitForWatcherActive(expect, workspace, writer, reader);

      // Write multiple files simultaneously — they should be batched into one notification
      await Promise.all([
        writeFile(path.join(workspace.dir, 'batch-a.ts'), 'export const a = 1;'),
        writeFile(path.join(workspace.dir, 'batch-b.ts'), 'export const b = 2;'),
        writeFile(path.join(workspace.dir, 'batch-c.ts'), 'export const c = 3;'),
      ]);

      // At least two of the batch files should appear in a single changes array
      // (proving they were batched rather than sent as separate notifications)
      await vi.waitFor(async () => {
        const res = await request({ writer, reader }, workspace.nextSeq(), '$/watcherEvents');

        expect(res).toMatchObject({
          result: watcherEventContaining(expect, 'batch-a.ts', 'batch-b.ts'),
        });
      }, watcherWaitOptions);
    });
  });
});
