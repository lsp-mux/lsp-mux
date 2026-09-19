import { faker } from '@faker-js/faker';
import { describe, it, vi } from 'vitest';
import { type MockProxy, mock } from 'vitest-mock-extended';
import { createBridgeRouter } from '../src/bridge.ts';
import type { BridgeConfig } from '../src/config-schema.ts';
import type { Logger } from '../src/logger.ts';
import type { ManagedServer } from '../src/managed-server.ts';
import { createNotification } from '../src/types.ts';
import type { Message, NotificationMessage } from '../src/types.ts';

const tsserverRequest = (id: number, command: string, args: unknown): NotificationMessage =>
  createNotification('tsserver/request', [id, command, args]);

const answering = (result: object): MockProxy<ManagedServer> => {
  const server = mock<ManagedServer>();
  server.sendRequest.mockResolvedValue({ jsonrpc: '2.0', id: 0, result });
  return server;
};

/** A router wired to a source and a target, with both mocks to inspect. */
const bridged = (target: MockProxy<ManagedServer> = answering({ body: 'ok' })) => {
  const source = mock<ManagedServer>();
  const log = mock<Logger>();
  const bridges: BridgeConfig[] = [{ protocol: 'tsserver', from: 'vue', to: 'vtsls' }];
  const router = createBridgeRouter(
    bridges,
    new Map([['vue', source], ['vtsls', target]]),
    log,
  );
  return { router, source, target, log };
};

/** The params of the single notification sent to a server. */
const sentNotification = (server: MockProxy<ManagedServer>): Message | undefined =>
  server.send.mock.calls[0]?.[0];

describe('createBridgeRouter', () => {
  it('claims a bridged notification so it never reaches the client', ({ expect }) => {
    const { router } = bridged();

    expect(router.handleNotification('vue', tsserverRequest(1, '_vue:x', {}))).toBe(true);
  });

  it('leaves a notification from a server no bridge names alone', ({ expect }) => {
    const { router, target } = bridged();

    expect(router.handleNotification('vtsls', tsserverRequest(1, '_vue:x', {}))).toBe(false);
    expect(target.sendRequest).not.toHaveBeenCalled();
  });

  it('leaves a method no bridge claims alone', ({ expect }) => {
    const { router } = bridged();
    const other = createNotification('window/logMessage', { type: 3, message: 'hi' });

    expect(router.handleNotification('vue', other)).toBe(false);
  });

  it('drops a malformed request rather than answering it', async ({ expect }) => {
    const { router, source, target, log } = bridged();

    const isClaimed = router.handleNotification(
      'vue',
      createNotification('tsserver/request', {}),
    );
    await Promise.resolve();

    /* Nothing to correlate an answer with, so the only safe move is to
       drop it: inventing an id would settle a request nobody made. */
    expect(isClaimed).toBe(true);
    expect(target.sendRequest).not.toHaveBeenCalled();
    expect(source.send).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('malformed'));
  });

  it('answers with an empty body when the command result carries none', async ({ expect }) => {
    const { router, source } = bridged(answering({ notABody: true }));
    const id = faker.number.int({ max: 1000 });

    router.handleNotification('vue', tsserverRequest(id, '_vue:x', {}));
    await vi.waitFor(() => {
      expect(source.send).toHaveBeenCalledTimes(1);
    });

    /* The sender holds a handler open for every id, so a result it cannot
       read still has to come back as an answer rather than silence. */
    expect(sentNotification(source)).toStrictEqual(
      createNotification('tsserver/response', [id, undefined]),
    );
  });
});
