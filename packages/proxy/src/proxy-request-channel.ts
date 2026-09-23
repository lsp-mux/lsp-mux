import type { ChildServer } from './child-server.ts';
import { Message as Msg, createRequest, defaultTimers, lspErrorCodes } from './types.ts';
import type { Message, RequestMessage, ResponseMessage, Timers } from './types.ts';

const defaultTimeoutMs = 30_000;

/*
 * The handshake is what makes a server run rather than a request against one
 * already running, and for a TypeScript or Vue server it loads a project
 * first. Several servers start together on the first didOpen, so they compete
 * for the machine exactly when each costs the most. Giving up there costs more
 * than waiting: the proxy reads a timeout as a failed start, spawns another
 * server onto the same busy machine, and can exhaust the restart budget before
 * any of them answers.
 */
const initializeTimeoutMs = 120_000;

const timeoutFor = (method: string): number =>
  method === 'initialize' ? initializeTimeoutMs : defaultTimeoutMs;

const idPrefix = '__proxy:';

/**
 * True for request IDs the proxy minted for itself rather than the client.
 */
export const isInternalRequestId = (id: number | string | null): boolean =>
  typeof id === 'string' && id.startsWith(idPrefix);

/**
 * Whether a delivery attempt reached the server.
 */
export type DeliveryOutcome = 'delivered' | 'undeliverable';

/**
 * Hand a request to a server, reporting whether it got there.
 */
export type DeliverRequest = (msg: RequestMessage) => DeliveryOutcome;

/**
 * Correlates proxy-internal requests (initialize, shutdown, diagnostics
 * pulls) with their responses via namespaced `__proxy:` request IDs, so
 * they never collide with client-originated IDs.
 */
export interface ProxyRequestChannel {
  /**
   * Send an internal request; resolves with the response or a timeout error.
   */
  readonly send: (
    target: ChildServer,
    method: string,
    params: RequestMessage['params'],
    timeoutMs?: number,
  ) => Promise<ResponseMessage>;
  /**
   * Send an internal request through a caller-supplied delivery function —
   * for routes that buffer or lazily start the server rather than writing
   * straight to a running child. Resolves with an error when delivery fails.
   */
  readonly sendVia: (
    deliver: DeliverRequest,
    method: string,
    params: RequestMessage['params'],
    timeoutMs?: number,
  ) => Promise<ResponseMessage>;
  /**
   * Resolve a pending internal request. Returns true if the message was consumed.
   */
  readonly handleResponse: (msg: Message) => boolean;
  /**
   * Fail all in-flight internal requests with an error response.
   */
  readonly rejectAll: (message: string) => void;
}

const errorResponse = (id: string, message: string): ResponseMessage => ({
  jsonrpc: '2.0',
  id,
  error: { code: lspErrorCodes.InternalError, message },
});

export const createProxyRequestChannel = (
  name: string,
  timers: Timers = defaultTimers,
): ProxyRequestChannel => {
  let seq = 0;
  const callbacks = new Map<string, (res: ResponseMessage) => void>();
  const ownPrefix = `${idPrefix}${name}:`;

  const sendVia = (
    deliver: DeliverRequest,
    method: string,
    params: RequestMessage['params'],
    timeoutMs = timeoutFor(method),
  ): Promise<ResponseMessage> => {
    const id = `${ownPrefix}${String(seq++)}`;
    return new Promise<ResponseMessage>((resolve) => {
      const timer = timers.setTimeout(() => {
        callbacks.delete(id);
        resolve(errorResponse(id, `Request ${method} timed out after ${String(timeoutMs)}ms`));
      }, timeoutMs);

      callbacks.set(id, (res) => {
        timers.clearTimeout(timer);
        resolve(res);
      });

      if (deliver(createRequest(id, method, params)) === 'undeliverable') {
        timers.clearTimeout(timer);
        callbacks.delete(id);
        resolve(errorResponse(id, 'Server not running'));
      }
    });
  };

  return {
    sendVia,

    send(target, method, params, timeoutMs) {
      return sendVia(
        (msg) => {
          target.write(msg);
          return 'delivered';
        },
        method,
        params,
        timeoutMs,
      );
    },

    handleResponse(msg) {
      if (!Msg.isResponse(msg) || typeof msg.id !== 'string' || !msg.id.startsWith(ownPrefix)) {
        return false;
      }
      const cb = callbacks.get(msg.id);
      if (cb) {
        cb(msg);
        callbacks.delete(msg.id);
      }
      return true;
    },

    rejectAll(message) {
      for (const [id, cb] of callbacks) {
        cb(errorResponse(id, message));
      }
      callbacks.clear();
    },
  };
};
