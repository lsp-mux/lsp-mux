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
import { it } from './harness.ts';

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
});
