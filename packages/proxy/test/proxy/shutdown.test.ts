/**
 * @module-tag slow
 */
import { describe, vi } from 'vitest';
import type { ExpectStatic } from 'vitest';
import { fakeUri } from '../helpers/fake.ts';
import {
  type Client,
  initializeProxy,
  notify,
  openDocument,
  request,
} from '../helpers/test-client.ts';
import { type ServerConfig, it, mockServerConfig } from './harness.ts';

/**
 * Bring the proxy up with one server spawned and answering, the only state a
 * shutdown can leave a server running from.
 */
const startWithRunningServer = async (client: Client): Promise<void> => {
  await initializeProxy(client);
  await openDocument(client.writer);
  // A hover the server answers is the fence: lazy start has finished by then.
  await request(client, 10, 'textDocument/hover', {
    textDocument: { uri: fakeUri() },
    position: { line: 0, character: 0 },
  });
};

/**
 * How many times the proxy has run its teardown, which it logs once per run.
 */
const countTeardowns = (logLines: readonly string[]): number =>
  logLines.filter(line => line.includes('Proxy shut down')).length;

/**
 * Wait for the child process to be gone. The proxy's log is what reports it:
 * the test holds no handle on a server the proxy spawned itself.
 */
const waitForServerExit = (expect: ExpectStatic, logLines: readonly string[]) =>
  vi.waitFor(
    () => {
      expect(logLines.join('')).toMatch(/mock exited/v);
    },
    { timeout: 10_000, interval: 50 },
  );

describe('LspProxy shutdown', () => {
  it('stops the servers when the client shuts down over the protocol', async ({
    createProxy,
    logLines,
    expect,
  }) => {
    const { writer, reader, started } = createProxy();

    await startWithRunningServer({ writer, reader });

    await request({ writer, reader }, 99, 'shutdown');
    await notify(writer, 'exit');

    /*
     * The exit comes first because a proxy that never tears down leaves the
     * promise below pending for the whole test timeout rather than failing.
     */
    await waitForServerExit(expect, logLines);

    await expect(started).resolves.toBeUndefined();
  });

  it('stops the servers when the client disconnects after shutdown', async ({
    createProxy,
    logLines,
    expect,
  }) => {
    const { writer, reader, clientToProxy, started } = createProxy();

    await startWithRunningServer({ writer, reader });

    await request({ writer, reader }, 99, 'shutdown');

    // No exit arrives: the closed connection is all the proxy has to act on.
    clientToProxy.end();

    await waitForServerExit(expect, logLines);

    await expect(started).resolves.toBeUndefined();
  });

  /*
   * A server that exits rather than answering leaves `shutdownAllServers`
   * awaiting while the stop it reports tears the proxy down, so the
   * continuation runs against a proxy that is already disposed.
   */
  it('stays disposed when a server stops mid-shutdown', async ({
    createProxy,
    logLines,
    expect,
  }) => {
    const config: ServerConfig = {
      ...mockServerConfig,
      args: [...mockServerConfig.args, '--exit-on-shutdown'],
    };
    const { proxy, writer, reader, started } = createProxy({ config });

    await startWithRunningServer({ writer, reader });

    const shutdownRes = await request({ writer, reader }, 99, 'shutdown');

    // The client is owed its answer even though the teardown got there first.
    /* eslint-disable-next-line unicorn/no-null -- LSP protocol uses null on the wire. */
    expect(shutdownRes).toMatchObject({ result: null });

    await expect(started).resolves.toBeUndefined();

    /*
     * The only way left to ask: the teardown disposed the client reader, so
     * nothing sent from here is read. A second call is a no-op while the
     * proxy is still disposed, and repeats the teardown once it is not.
     */
    proxy.dispose();

    expect(countTeardowns(logLines)).toBe(1);
  });
});
