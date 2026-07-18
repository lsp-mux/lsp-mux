import type { ChildServer } from './child-server.ts';
import { Message as Msg, createRequest, lspErrorCodes } from './types.ts';
import type { Message, RequestMessage, ResponseMessage } from './types.ts';

const defaultTimeoutMs = 30_000;

/**
 * Correlates proxy-internal requests (initialize, shutdown, diagnostics
 * pulls) with their responses via namespaced `__proxy:` request IDs, so
 * they never collide with client-originated IDs.
 */
export interface ProxyRequestChannel {
  /** Send an internal request; resolves with the response or a timeout error. */
  readonly send: (
    target: ChildServer,
    method: string,
    params: RequestMessage['params'],
    timeoutMs?: number,
  ) => Promise<ResponseMessage>;
  /** Resolve a pending internal request. Returns true if the message was consumed. */
  readonly handleResponse: (msg: Message) => boolean;
  /** Fail all in-flight internal requests with an error response. */
  readonly rejectAll: (message: string) => void;
}

export const createProxyRequestChannel = (name: string): ProxyRequestChannel => {
  let seq = 0;
  const callbacks = new Map<string, (res: ResponseMessage) => void>();
  const idPrefix = `__proxy:${name}:`;

  return {
    send(target, method, params, timeoutMs = defaultTimeoutMs) {
      const id = `${idPrefix}${String(seq++)}`;
      return new Promise<ResponseMessage>((resolve) => {
        const timer = setTimeout(() => {
          callbacks.delete(id);
          resolve({
            jsonrpc: '2.0',
            id,
            error: {
              code: lspErrorCodes.InternalError,
              message: `Request ${method} timed out after ${String(timeoutMs)}ms`,
            },
          });
        }, timeoutMs);

        callbacks.set(id, (res) => {
          clearTimeout(timer);
          resolve(res);
        });

        target.write(createRequest(id, method, params));
      });
    },

    handleResponse(msg) {
      if (!Msg.isResponse(msg) || typeof msg.id !== 'string' || !msg.id.startsWith(idPrefix)) {
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
        cb({ jsonrpc: '2.0', id, error: { code: lspErrorCodes.InternalError, message } });
      }
      callbacks.clear();
    },
  };
};
