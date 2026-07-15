import { ChildServer } from './child-server.ts';
import type { Logger } from './logger.ts';
import { createMessageBuffer } from './message-buffer.ts';
import { defaultRestartPolicy, createRestartScheduler } from './restart-scheduler.ts';
import type { RestartPolicy } from './restart-scheduler.ts';
import type { Message, RequestMessage, ResponseMessage, ServerConfig, TrackedDocument } from './types.ts';
import { documentSyncMethods, lspErrorCodes, Message as Msg, createNotification, createRequest } from './types.ts';

const maxBufferSize = 1000;

export type ServerState = 'idle' | 'starting' | 'running' | 'restarting' | 'stopped';

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

  /** Store init params for deferred (lazy) initialization. */
  setInitParams: (params: RequestMessage['params']) => void;
  /** Spawn server and send initialize. Resolves with the raw response. */
  initialize: (params: RequestMessage['params']) => Promise<ResponseMessage>;
  /** Mark the proxy-level handshake as complete. Enables lazy start on idle servers. */
  sendInitialized: () => void;
  /** Route a message to this server. Triggers lazy start if idle; buffers if starting/restarting. */
  send: (msg: Message) => boolean;
  /** Try to cancel a buffered request by ID. Returns true if found and removed. */
  cancelBuffered: (id: number | string) => boolean;
  /** Send a proxy-internal request and return the response. Only works when running. */
  sendRequest: (method: string, params: RequestMessage['params']) => Promise<ResponseMessage>;
  /** Send shutdown request. Resolves with the response. */
  shutdown: () => Promise<ResponseMessage>;
  /** Clean up all resources. */
  dispose: () => void;
}

export const createManagedServer = (
  name: string,
  config: ServerConfig,
  callbacks: ManagedServerCallbacks,
  log: Logger,
  restartPolicy?: Partial<RestartPolicy>,
): ManagedServer => {
  let state: ServerState = 'idle';
  let server: ChildServer | undefined;
  let initParams: RequestMessage['params'];
  let isShutdownSent = false;

  // Set by sendInitialized() after the client completes the LSP handshake.
  // Gates lazy start: send() on idle servers only triggers start after this is true.
  let isLazyStartEnabled = false;

  // Whether this server has ever completed a full init sequence (initialize + initialized).
  // Gates restart: crash before first successful init → stop permanently (no retry).
  let isEverInitialized = false;

  const pendingRequests = new Set<number | string | null>();
  const buffer = createMessageBuffer(maxBufferSize);
  const scheduler = createRestartScheduler({ policy: { ...defaultRestartPolicy, ...restartPolicy } });

  let proxySeq = 0;
  const proxyCallbacks = new Map<string, (res: ResponseMessage) => void>();

  // -- Internal helpers --

  const resolveProxyCallbacks = (message: string): void => {
    for (const [id, cb] of proxyCallbacks) {
      cb({ jsonrpc: '2.0', id, error: { code: lspErrorCodes.InternalError, message } });
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
          error: { code: lspErrorCodes.InternalError, message: `Request ${method} timed out after ${String(timeoutMs)}ms` },
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
    }, log);
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
    server = undefined;

    if (!isEverInitialized) {
      log.error(`${name}: crashed before initial handshake — stopping`);
      state = 'stopped';
      scheduler.cancel();
      errorBufferedRequests('Server stopped');
      callbacks.onStateChange(state);
      return;
    }

    if (isShutdownSent) {
      log.info(`${name}: exited after shutdown — not restarting`);
      state = 'stopped';
      scheduler.cancel();
      callbacks.onStateChange(state);
      return;
    }

    // If already starting/restarting (crash during init sequence), let performInitSequence reschedule
    if (state === 'starting' || state === 'restarting') return;

    state = 'restarting';
    callbacks.onStateChange(state);
    scheduleRetry('restarting');
  };

  const scheduleRetry = (expectedState: 'starting' | 'restarting'): void => {
    const isScheduled = scheduler.schedule(() => void performInitSequence(expectedState));
    if (!isScheduled) {
      log.error(`${name}: max attempts (${String(scheduler.maxRetries)}) reached — stopping`);
      state = 'stopped';
      errorBufferedRequests('Server stopped');
      callbacks.onStateChange(state);
      return;
    }

    const label = expectedState === 'starting' ? 'start' : 'restart';
    log.info(`${name}: scheduling ${label} (attempt ${String(scheduler.attempt)}/${String(scheduler.maxRetries)})`);
  };

  const performInitSequence = async (expectedState: 'starting' | 'restarting'): Promise<void> => {
    if (state !== expectedState) return;

    const label = expectedState === 'starting' ? 'lazy start' : 'restart';

    try {
      const child = spawnServer();

      const initResponse = await sendProxyRequest(child, 'initialize', initParams);

      if (state !== expectedState || server !== child) {
        if (state === expectedState) scheduleRetry(expectedState);
        return;
      }

      if (initResponse.error) {
        log.error(`${name}: ${label} initialize failed:`, initResponse.error.message);
        child.dispose();
        server = undefined;
        scheduleRetry(expectedState);
        return;
      }

      child.write(createNotification('initialized', {}));
      if (config.settings) {
        child.write(createNotification('workspace/didChangeConfiguration', {
          settings: config.settings,
        }));
      }
      isEverInitialized = true;

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

      if (state !== expectedState || server !== child) {
        if (state === expectedState) scheduleRetry(expectedState);
        return;
      }

      state = 'running';
      scheduler.reset();
      callbacks.onStateChange(state);
      log.info(`${name}: ${label} completed`);
    } catch (error) {
      log.error(`${name}: ${label} failed:`, error);
      server?.dispose();
      server = undefined;
      if (state === expectedState) scheduleRetry(expectedState);
    }
  };

  /** Drain buffered requests and notify proxy so it can send error responses. */
  const errorBufferedRequests = (message: string): void => {
    const flushed = buffer.flush();
    const ids = new Set<number | string | null>();
    for (const msg of flushed) {
      if (Msg.isRequest(msg)) ids.add(msg.id);
    }
    if (ids.size > 0) {
      callbacks.onPendingErrors(ids, message);
    }
  };

  const cancelRestart = (): void => {
    scheduler.cancel();
    resolveProxyCallbacks('Restart cancelled');
    server?.dispose();
    server = undefined;
  };

  // -- Public interface --

  return {
    get name() { return name; },
    get state() { return state; },

    setInitParams(params) {
      initParams = params;
    },

    async initialize(params) {
      initParams = params;
      const child = spawnServer();
      const response = await sendProxyRequest(child, 'initialize', params);
      return response;
    },

    sendInitialized() {
      isLazyStartEnabled = true;
      // Idle servers haven't been spawned yet — nothing to send.
      // They'll run the full init sequence on first matching message.
      if (!server) return;
      isEverInitialized = true;
      state = 'running';
      server.write(createNotification('initialized', {}));
    },

    send(msg) {
      if (state === 'running') {
        if (Msg.isRequest(msg)) {
          pendingRequests.add(msg.id);
          if (msg.method === 'shutdown') isShutdownSent = true;
        }
        server?.write(msg);
        return true;
      }

      // Document sync notifications are tracked centrally by the proxy.
      // Drop them here — they'll be replayed via getDocuments() after init.
      const isDocSync = Msg.isNotification(msg) && documentSyncMethods.has(msg.method);

      if (state === 'restarting' || state === 'starting') {
        if (isDocSync) return true;
        return !!buffer.offer(msg);
      }

      // Lazy start: first message to an idle server triggers spawn
      if (state === 'idle' && initParams !== undefined && isLazyStartEnabled) {
        state = 'starting';
        callbacks.onStateChange(state);
        if (!isDocSync) buffer.offer(msg);
        void performInitSequence('starting');
        return true;
      }

      return false; // stopped or idle without initParams/handshake
    },

    cancelBuffered(id) {
      return buffer.cancel(id);
    },

    sendRequest(method, params) {
      if (state !== 'running' || !server) {
        return Promise.resolve({
          jsonrpc: '2.0' as const,
          /* eslint-disable-next-line unicorn/no-null --
             JSON-RPC requires an explicit null id when no request id applies. */
          id: null,
          error: { code: lspErrorCodes.InternalError, message: 'Server not running' },
        });
      }
      return sendProxyRequest(server, method, params);
    },

    async shutdown() {
      isShutdownSent = true;
      if (state === 'restarting' || state === 'starting') {
        cancelRestart();
        state = 'stopped';
        callbacks.onStateChange(state);
        /* eslint-disable-next-line unicorn/no-null --
           A synthesized JSON-RPC shutdown response requires null id/result. */
        return { jsonrpc: '2.0' as const, id: null, result: null };
      }
      if (state !== 'running' || !server) {
        state = 'stopped';
        callbacks.onStateChange(state);
        /* eslint-disable-next-line unicorn/no-null --
           A synthesized JSON-RPC shutdown response requires null id/result. */
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
