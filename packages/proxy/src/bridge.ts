/*
 * Server-to-server notification bridging.
 *
 * Volar 3 dropped hybrid mode: it no longer talks to a TypeScript server
 * itself, and instead asks its editor to. It sends `tsserver/request`
 * [id, command, args]; the editor runs the command against its TypeScript
 * server and answers `tsserver/response` [id, body]. The proxy already
 * manages such a server, so it plays the editor's part here rather than
 * passing the notification on to a client that knows nothing about it.
 */
import * as v from 'valibot';
import type { BridgeConfig } from './config-schema.ts';
import type { Logger } from './logger.ts';
import type { ManagedServer } from './managed-server.ts';
import { createNotification } from './types.ts';
import type { NotificationMessage } from './types.ts';

/*
 * vtsls exposes tsserver as the `typescript.tsserverRequest` command, taking
 * [command, args, config]. The config mirrors what VS Code's own Vue client
 * passes: the request is answered out of band and must not jump the queue
 * ahead of the user's own edits.
 */
const tsserverProtocol = {
  command: 'typescript.tsserverRequest',
  config: { isAsync: true, lowPriority: true },
  request: 'tsserver/request',
  response: 'tsserver/response',
} as const;

/*
 * vscode-languageserver packs a notification's single argument into the params
 * array, so Volar's sendNotification('tsserver/request', [id, command, args])
 * reaches the wire as [[id, command, args]]. Its own client unpacks that before
 * the handler sees it; a peer speaking raw LSP has to unpack it itself, and
 * pack the answer the same way or Volar's handler destructures a number.
 */
const TsserverRequestTupleSchema = v.tuple([v.unknown(), v.string(), v.unknown()]);

const TsserverRequestSchema = v.pipe(
  v.tuple([TsserverRequestTupleSchema]),
  v.transform(([request]) => request),
);

const ExecuteCommandResultSchema = v.object({ body: v.optional(v.unknown()) });

export interface BridgeRouter {
  /**
   * Handle a notification a bridge claims. Returns true when it was
   * consumed, meaning it must not also reach the client.
   */
  readonly handleNotification: (serverName: string, msg: NotificationMessage) => boolean;
}

export const createBridgeRouter = (
  bridges: readonly BridgeConfig[] | undefined,
  servers: ReadonlyMap<string, ManagedServer>,
  log: Logger,
): BridgeRouter => {
  /** Source server → the server its tsserver requests are answered by. */
  const targets = new Map((bridges ?? []).map(bridge => [bridge.from, bridge.to]));

  /** Run one tsserver command on the target, and return the body it answered. */
  const runCommand = async (to: string, command: string, args: unknown): Promise<unknown> => {
    const target = servers.get(to);
    if (!target) {
      log.error(`Unknown bridge target: ${to}`);
      return undefined;
    }

    const res = await target.sendRequest('workspace/executeCommand', {
      command: tsserverProtocol.command,
      arguments: [command, args, tsserverProtocol.config],
    });
    if (res.error) {
      log.warn(`${to}: ${command} failed — ${res.error.message}`);
      return undefined;
    }

    const parsed = v.safeParse(ExecuteCommandResultSchema, res.result);
    return parsed.success ? parsed.output.body : undefined;
  };

  const forwardTsserverRequest = async (
    from: string,
    to: string,
    params: NotificationMessage['params'],
  ): Promise<void> => {
    const parsed = v.safeParse(TsserverRequestSchema, params);
    if (!parsed.success) {
      log.warn(`${from}: malformed ${tsserverProtocol.request} — dropping`);
      return;
    }
    const [id, command, args] = parsed.output;

    log.debug(`${from} → ${to}: ${command}`);
    const body = await runCommand(to, command, args);

    /*
     * An empty body still gets answered: the source server holds a handler
     * open for every id it sends, and a dropped response strands it.
     */
    servers.get(from)?.send(createNotification(tsserverProtocol.response, [[id, body]]));
  };

  return {
    handleNotification(serverName, msg) {
      if (msg.method !== tsserverProtocol.request) return false;
      const target = targets.get(serverName);
      if (target === undefined) return false;

      void forwardTsserverRequest(serverName, target, msg.params);
      return true;
    },
  };
};
