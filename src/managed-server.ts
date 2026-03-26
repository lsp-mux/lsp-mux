import type { Message, RequestMessage, ResponseMessage, ServerConfig, TrackedDocument } from './types.js';
import { Message as Msg, createRequest, createNotification, DOCUMENT_SYNC_METHODS, LSP_ERROR_CODES } from './types.js';
import { ChildServer } from './child-server.js';
import { createMessageBuffer } from './message-buffer.js';
import { createRestartScheduler, DEFAULT_RESTART_POLICY } from './restart-scheduler.js';
import type { RestartPolicy } from './restart-scheduler.js';
import { log } from './logger.js';

const MAX_BUFFER_SIZE = 1000;

export type ServerState = 'idle' | 'running' | 'restarting' | 'stopped';

export interface ManagedServerCallbacks {
  /** Server produced a message (response or notification) for the proxy. */
  readonly onServerMessage: (msg: Message) => void;
  /** Server crashed — these client request IDs need error responses. */
  readonly onPendingErrors: (ids: ReadonlySet<number | string | null>, message: string) => void;
  /** Server state changed. */
  readonly onStateChange: (state: ServerState) => void;
  /** Get current document state for replay after restart. */
  readonly getDocuments: () => readonly TrackedDocument[];
}

export interface ManagedServer {
  readonly name: string;
  readonly state: ServerState;

  /** Spawn server and send initialize. Resolves with the raw response. */
  initialize(params: RequestMessage['params']): Promise<ResponseMessage>;
  /** Send the 'initialized' notification. Marks handshake complete for restart purposes. */
  sendInitialized(): void;
  /** Route a message to this server. Buffers if restarting; returns false if buffer full or stopped. */
  send(msg: Message): boolean;
  /** Try to cancel a buffered request by ID. Returns true if found and removed. */
  cancelBuffered(id: number | string): boolean;
  /** Send shutdown request. Resolves with the response. */
  shutdown(): Promise<ResponseMessage>;
  /** Clean up all resources. */
  dispose(): void;
}

export const createManagedServer = (
  name: string,
  config: ServerConfig,
  callbacks: ManagedServerCallbacks,
  restartPolicy?: Partial<RestartPolicy>,
): ManagedServer => {
  let state: ServerState = 'idle';
  let server: ChildServer | null = null;
  let initParams: RequestMessage['params'];
  let everInitialized = false;
  let shutdownSent = false;

  const pendingRequests = new Set<number | string | null>();
  const buffer = createMessageBuffer(MAX_BUFFER_SIZE);
  const scheduler = createRestartScheduler({ ...DEFAULT_RESTART_POLICY, ...restartPolicy });

  let proxySeq = 0;
  const proxyCallbacks = new Map<string, (res: ResponseMessage) => void>();

  // -- Internal helpers --

  const resolveProxyCallbacks = (message: string): void => {
    for (const [id, cb] of proxyCallbacks) {
      cb({ jsonrpc: '2.0', id, error: { code: LSP_ERROR_CODES.InternalError, message } });
    }
    proxyCallbacks.clear();
  };

  const sendProxyRequest = (
    target: ChildServer,
    method: string,
    params: RequestMessage['params'],
    timeoutMs = 30_000,
  ): Promise<ResponseMessage> => {
    const id = `__proxy:${name}:${String(proxySeq++)}`;
    return new Promise<ResponseMessage>((resolve) => {
      const timer = setTimeout(() => {
        proxyCallbacks.delete(id);
        resolve({
          jsonrpc: '2.0',
          id,
          error: { code: LSP_ERROR_CODES.InternalError, message: `Request ${method} timed out after ${String(timeoutMs)}ms` },
        });
      }, timeoutMs);

      proxyCallbacks.set(id, (res) => {
        clearTimeout(timer);
        resolve(res);
      });

      target.write(createRequest(id, method, params));
    });
  };

  const spawnServer = (): ChildServer => {
    const child = new ChildServer(name, config, {
      onMessage: (msg) => { handleServerMessage(msg); },
      onExit: () => { handleServerExit(); },
      onError: (err) => {
        log.error(`${name} spawn error:`, err);
        handleServerExit();
      },
    });
    child.start();
    server = child;
    return child;
  };

  const handleServerMessage = (msg: Message): void => {
    // Internal proxy response (e.g., initialize during restart)
    if (Msg.isResponse(msg) && typeof msg.id === 'string' && msg.id.startsWith(`__proxy:${name}:`)) {
      const cb = proxyCallbacks.get(msg.id);
      if (cb) {
        cb(msg);
        proxyCallbacks.delete(msg.id);
      }
      return;
    }

    // Client response — untrack pending request
    if (Msg.isResponse(msg) && msg.id !== null) {
      pendingRequests.delete(msg.id);
    }

    callbacks.onServerMessage(msg);
  };

  const handleServerExit = (): void => {
    if (state === 'stopped') return;

    resolveProxyCallbacks('Server exited');

    // Notify proxy about pending requests that need error responses
    if (pendingRequests.size > 0) {
      callbacks.onPendingErrors(new Set(pendingRequests), 'Server crashed');
      pendingRequests.clear();
    }

    server?.dispose();
    server = null;

    if (!everInitialized) {
      log.error(`${name}: crashed before initial handshake — stopping`);
      state = 'stopped';
      callbacks.onStateChange(state);
      return;
    }

    if (shutdownSent) {
      log.info(`${name}: exited after shutdown — not restarting`);
      state = 'stopped';
      callbacks.onStateChange(state);
      return;
    }

    // If already restarting (crash during restart), let performRestart reschedule
    if (state === 'restarting') return;

    state = 'restarting';
    callbacks.onStateChange(state);
    scheduleRestart();
  };

  const scheduleRestart = (): void => {
    if (state !== 'restarting') return;

    const scheduled = scheduler.schedule(() => void performRestart());
    if (!scheduled) {
      log.error(`${name}: max restart attempts (${String(scheduler.maxRetries)}) reached — stopping`);
      state = 'stopped';
      callbacks.onStateChange(state);
      return;
    }

    log.info(`${name}: scheduling restart (attempt ${String(scheduler.attempt)}/${String(scheduler.maxRetries)})`);
  };

  const performRestart = async (): Promise<void> => {
    if (state !== 'restarting') return;

    try {
      const child = spawnServer();

      const initResponse = await sendProxyRequest(child, 'initialize', initParams);

      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- state mutates across await via handleServerExit
      if (state !== 'restarting' || server !== child) {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- state mutates across await via handleServerExit
        if (state === 'restarting') scheduleRestart();
        return;
      }

      if (initResponse.error) {
        log.error(`${name}: restart initialize failed:`, initResponse.error.message);
        child.dispose();
        server = null;
        scheduleRestart();
        return;
      }

      child.write(createNotification('initialized', {}));

      // Replay tracked document state
      const documents = callbacks.getDocuments();
      for (const doc of documents) {
        child.write(createNotification('textDocument/didOpen', {
          textDocument: {
            uri: doc.uri,
            languageId: doc.languageId,
            version: doc.version,
            text: doc.content,
          },
        }));
      }
      log.info(`${name}: replayed ${String(documents.length)} document(s)`);

      // Flush buffered messages
      const flushed = buffer.flush();
      for (const msg of flushed) {
        if (Msg.isRequest(msg)) pendingRequests.add(msg.id);
        child.write(msg);
      }
      if (flushed.length > 0) log.info(`${name}: flushed ${String(flushed.length)} buffered message(s)`);

      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- state mutates across await via handleServerExit
      if (state !== 'restarting' || server !== child) {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- state mutates across await via handleServerExit
        if (state === 'restarting') scheduleRestart();
        return;
      }

      state = 'running';
      scheduler.reset();
      callbacks.onStateChange(state);
      log.info(`${name}: restarted successfully`);
    }
    catch (err) {
      log.error(`${name}: restart failed:`, err);
      server?.dispose();
      server = null;
      if (state === 'restarting') scheduleRestart();
    }
  };

  const cancelRestart = (): void => {
    scheduler.cancel();
    resolveProxyCallbacks('Restart cancelled');
    server?.dispose();
    server = null;
  };

  // -- Public interface --

  return {
    get name() { return name; },
    get state() { return state; },

    async initialize(params) {
      initParams = params;
      const child = spawnServer();
      const response = await sendProxyRequest(child, 'initialize', params);
      return response;
    },

    sendInitialized() {
      everInitialized = true;
      state = 'running';
      server?.write(createNotification('initialized', {}));
    },

    send(msg) {
      if (state === 'running') {
        if (Msg.isRequest(msg)) {
          pendingRequests.add(msg.id);
          if (msg.method === 'shutdown') shutdownSent = true;
        }
        server?.write(msg);
        return true;
      }

      if (state === 'restarting') {
        // Document sync notifications are already tracked by the proxy; skip during restart
        if (Msg.isNotification(msg) && DOCUMENT_SYNC_METHODS.has(msg.method)) return true;

        if (!buffer.push(msg)) {
          return false; // Buffer full
        }
        return true;
      }

      return false; // stopped or idle
    },

    cancelBuffered(id) {
      return buffer.cancel(id);
    },

    async shutdown() {
      shutdownSent = true;
      if (state === 'restarting') {
        cancelRestart();
        state = 'stopped';
        callbacks.onStateChange(state);
        return { jsonrpc: '2.0' as const, id: null, result: null };
      }
      if (state !== 'running' || !server) {
        state = 'stopped';
        callbacks.onStateChange(state);
        return { jsonrpc: '2.0' as const, id: null, result: null };
      }
      const response = await sendProxyRequest(server, 'shutdown', undefined);
      return response;
    },

    dispose() {
      if (state === 'stopped') return;
      state = 'stopped';
      cancelRestart();
    },
  };
};
