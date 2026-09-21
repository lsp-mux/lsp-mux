/**
 * @module-tag slow
 */
import { describe, vi } from 'vitest';
import type { Message } from 'vscode-jsonrpc';
import { Message as Msg, createRequest } from '../../src/types.ts';
import { initializeProxy, request } from '../helpers/test-client.ts';
import { it, namedConfig } from './harness.ts';

const bridgedConfigs = (...targetArgs: string[]) => new Map([
  ['vue', namedConfig('vue', '--tsserver-client')],
  ['vtsls', namedConfig('vtsls', ...targetArgs)],
]);

const tsserverBridge = [{ protocol: 'tsserver', from: 'vue', to: 'vtsls' }] as const;

const isMethod = (msg: Message, method: string): boolean =>
  (Msg.isNotification(msg) || Msg.isRequest(msg)) && msg.method === method;

describe('Notification bridging', () => {
  it('forwards a tsserver request to the target and answers the source', async ({
    createProxy,
    expect,
  }) => {
    const { writer, reader } = createProxy({
      configs: bridgedConfigs(),
      bridges: tsserverBridge,
    });

    await initializeProxy({ writer, reader });

    const res = await request({ writer, reader }, 1, '$/sendTsserverRequest', {
      command: '_vue:getComponentNames',
      args: { file: 'App.vue' },
    });

    /*
     * The source server answers only once the bridged response reaches it,
     * so this result is the whole round trip: the command and args Volar
     * sent, wrapped as vtsls expects, and the body handed back under the
     * original correlation id.
     */
    expect(res.result).toStrictEqual({
      id: 1,
      body: {
        executed: {
          command: 'typescript.tsserverRequest',
          arguments: [
            '_vue:getComponentNames',
            { file: 'App.vue' },
            { isAsync: true, lowPriority: true },
          ],
        },
      },
    });
  });

  it('keeps the bridged notification away from the client', async ({ createProxy, expect }) => {
    const { writer, reader } = createProxy({
      configs: bridgedConfigs(),
      bridges: tsserverBridge,
    });

    await initializeProxy({ writer, reader });

    /*
     * One listener at a time on the reader, so everything the client sees
     * during the exchange is recorded here rather than awaited separately.
     */
    const seen: Message[] = [];
    const listener = reader.listen((msg) => {
      seen.push(msg);
    });

    await writer.write(createRequest(1, '$/sendTsserverRequest', {
      command: '_vue:getComponentNames',
      args: {},
    }));
    /* Both servers start lazily on this exchange, which outruns the default
       one-second budget when the whole suite runs at once. */
    await vi.waitFor(
      () => {
        expect(seen.some(msg => Msg.isResponse(msg) && msg.id === 1)).toBe(true);
      },
      { timeout: 10_000, interval: 50 },
    );
    listener.dispose();

    expect(seen.filter(msg => isMethod(msg, 'tsserver/request'))).toStrictEqual([]);
  });

  it('answers with an empty body when the target fails the command', async ({
    createProxy,
    expect,
  }) => {
    const { writer, reader } = createProxy({
      configs: bridgedConfigs('--execute-command-error'),
      bridges: tsserverBridge,
    });

    await initializeProxy({ writer, reader });

    const res = await request({ writer, reader }, 1, '$/sendTsserverRequest', {
      command: '_vue:getComponentNames',
      args: {},
    });

    /* Volar's own client answers an undefined body on failure, which
       reaches the server as null — a resolved request, not a hung one. */
    // eslint-disable-next-line unicorn/no-null -- JSON-RPC renders the absent body as null
    expect(res.result).toStrictEqual({ id: 1, body: null });
  });
});
