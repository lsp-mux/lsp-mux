import * as v from 'valibot';
import { StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node.js';
import type { Message, RequestMessage, ResponseMessage, ServerConfig } from './types.js';
import { Message as Msg, createRequest, createNotification, DOCUMENT_SYNC_METHODS, LSP_ERROR_CODES } from './types.js';
import { ChildServer } from './child-server.js';
import * as docs from './document-tracker.js';
import { createMessageBuffer } from './message-buffer.js';
import { createRestartScheduler, DEFAULT_RESTART_POLICY } from './restart-scheduler.js';
import type { RestartPolicy } from './restart-scheduler.js';
import { log } from './logger.js';

const MAX_BUFFER_SIZE = 1000;

const CancelParamsSchema = v.object({
  id: v.union([v.number(), v.string()]),
});

type ProxyState = 'idle' | 'running' | 'restarting' | 'stopped';

/**
 * Single-server LSP proxy.
 *
 * Sits between the client (stdio) and one child LSP server.
 * Handles initialize/shutdown coordination, document state tracking,
 * and transparent crash-restart with state replay.
 */
export class LspProxy {
  private readonly clientReader: StreamMessageReader;
  private readonly clientWriter: StreamMessageWriter;

  private state: ProxyState = 'idle';
  private server: ChildServer | null = null;
  private documents: docs.DocumentMap = docs.empty();
  private initParams: RequestMessage['params'];
  private initialized = false;
  private shutdownRequested = false;

  // Pending client requests — errored on crash
  private readonly pendingRequests = new Set<number | string | null>();

  // Restart infrastructure
  private readonly buffer = createMessageBuffer(MAX_BUFFER_SIZE);
  private readonly scheduler: ReturnType<typeof createRestartScheduler>;
  private proxySeq = 0;
  private readonly proxyCallbacks = new Map<string, (res: ResponseMessage) => void>();

  private resolveDone?: () => void;

  constructor(
    private readonly serverName: string,
    private readonly serverConfig: ServerConfig,
    options?: {
      input?: NodeJS.ReadableStream;
      output?: NodeJS.WritableStream;
      restartPolicy?: Partial<RestartPolicy>;
    },
  ) {
    this.clientReader = new StreamMessageReader(options?.input ?? process.stdin);
    this.clientWriter = new StreamMessageWriter(options?.output ?? process.stdout);
    this.scheduler = createRestartScheduler({ ...DEFAULT_RESTART_POLICY, ...options?.restartPolicy });
  }

  start(): Promise<void> {
    log.info('Proxy starting');
    this.clientReader.listen((msg) => this.handleClientMessage(msg));
    this.clientReader.onError((err) => log.error('Client reader error:', err));
    this.clientReader.onClose(() => {
      log.info('Client connection closed');
      this.dispose();
    });
    return new Promise((resolve) => { this.resolveDone = resolve; });
  }

  // ── Client → Server ──────────────────────────────────────────────────

  private handleClientMessage(msg: Message): void {
    if (Msg.isNotification(msg) && DOCUMENT_SYNC_METHODS.has(msg.method)) {
      this.documents = docs.apply(this.documents, msg.method, msg.params);
    }

    switch (this.state) {
      case 'idle':
        return this.handleIdleMessage(msg);
      case 'running':
        return this.forwardToServer(msg);
      case 'restarting':
        return this.handleRestartingMessage(msg);
      case 'stopped':
        if (Msg.isNotification(msg) && msg.method === 'exit') {
          this.clientReader.dispose();
          return;
        }
        if (Msg.isRequest(msg)) {
          this.sendErrorToClient(msg.id, LSP_ERROR_CODES.ServerNotInitialized, 'Server stopped');
        }
    }
  }

  private handleIdleMessage(msg: Message): void {
    if (Msg.isRequest(msg) && msg.method === 'initialize') {
      this.initParams = msg.params;
      const server = this.spawnServer();
      this.pendingRequests.add(msg.id);
      server.write(msg);
      this.state = 'running';
      return;
    }
    if (Msg.isRequest(msg)) {
      this.sendErrorToClient(msg.id, LSP_ERROR_CODES.ServerNotInitialized, 'Not initialized');
    }
  }

  private handleRestartingMessage(msg: Message): void {
    if (Msg.isNotification(msg) && DOCUMENT_SYNC_METHODS.has(msg.method)) return;

    if (Msg.isNotification(msg) && msg.method === 'exit') {
      this.dispose();
      return;
    }

    if (Msg.isNotification(msg) && msg.method === '$/cancelRequest') {
      const result = v.safeParse(CancelParamsSchema, msg.params);
      if (result.success && this.buffer.cancel(result.output.id)) {
        this.sendErrorToClient(result.output.id, LSP_ERROR_CODES.RequestCancelled, 'Request cancelled');
      }
      return;
    }

    if (Msg.isRequest(msg) && msg.method === 'shutdown') {
      this.respondToClient(msg.id, null);
      this.state = 'stopped';
      this.cancelRestart();
      return;
    }

    if (!this.buffer.push(msg) && Msg.isRequest(msg)) {
      this.sendErrorToClient(msg.id, LSP_ERROR_CODES.InternalError, 'Message buffer full');
    }
  }

  private forwardToServer(msg: Message): void {
    if (Msg.isRequest(msg)) {
      this.pendingRequests.add(msg.id);
      if (msg.method === 'shutdown') this.shutdownRequested = true;
    }

    if (Msg.isNotification(msg) && msg.method === 'exit') {
      this.server?.write(msg);
      this.dispose();
      return;
    }

    if (Msg.isNotification(msg) && msg.method === 'initialized') {
      this.initialized = true;
      log.info('LSP handshake complete');
    }

    this.server?.write(msg);
  }

  // ── Server → Client ──────────────────────────────────────────────────

  private handleServerMessage(msg: Message): void {
    if (Msg.isResponse(msg) && typeof msg.id === 'string' && msg.id.startsWith('__proxy:')) {
      const cb = this.proxyCallbacks.get(msg.id);
      if (cb) {
        cb(msg);
        this.proxyCallbacks.delete(msg.id);
      }
      return;
    }

    if (Msg.isResponse(msg) && msg.id !== null) {
      this.pendingRequests.delete(msg.id);
    }

    this.writeToClient(msg);
  }

  // ── Server lifecycle ──────────────────────────────────────────────────

  private spawnServer(): ChildServer {
    const server = new ChildServer(this.serverName, this.serverConfig, {
      onMessage: (msg) => this.handleServerMessage(msg),
      onExit: (code, signal) => this.handleServerExit(code, signal),
      onError: (err) => {
        log.error('Server spawn error:', err);
        this.handleServerExit(1, null);
      },
    });
    server.start();
    this.server = server;
    return server;
  }

  private handleServerExit(_code: number | null, _signal: string | null): void {
    if (this.state === 'stopped') return;

    this.resolveProxyCallbacks('Server exited');
    this.errorPendingRequests('Server crashed');

    this.server?.dispose();
    this.server = null;

    if (!this.initialized) {
      log.error('Server crashed before initial handshake completed — stopping');
      this.state = 'stopped';
      return;
    }

    if (this.shutdownRequested) {
      log.info('Server exited after shutdown — not restarting');
      this.state = 'stopped';
      return;
    }

    // If already restarting (crash during restart), let performRestart handle scheduling
    if (this.state === 'restarting') return;

    this.state = 'restarting';
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (this.state !== 'restarting') return;

    const scheduled = this.scheduler.schedule(() => void this.performRestart());
    if (!scheduled) {
      log.error(`Max restart attempts (${this.scheduler.maxRetries}) reached — stopping`);
      this.state = 'stopped';
      return;
    }

    log.info(`Scheduling restart (attempt ${this.scheduler.attempt}/${this.scheduler.maxRetries})`);
  }

  private async performRestart(): Promise<void> {
    if (this.state !== 'restarting') return;

    try {
      const server = this.spawnServer();

      const initResponse = await this.sendProxyRequest(server, 'initialize', this.initParams);

      if (this.state !== 'restarting' || this.server !== server) {
        if (this.state === 'restarting') this.scheduleRestart();
        return;
      }

      if (initResponse.error) {
        log.error('Restart initialize failed:', initResponse.error.message);
        server.dispose();
        this.server = null;
        this.scheduleRestart();
        return;
      }

      server.write(createNotification('initialized', {}));

      // Replay tracked document state
      const documents = docs.toArray(this.documents);
      for (const doc of documents) {
        server.write(createNotification('textDocument/didOpen', {
          textDocument: {
            uri: doc.uri,
            languageId: doc.languageId,
            version: doc.version,
            text: doc.content,
          },
        }));
      }
      log.info(`Replayed ${documents.length} document(s)`);

      // Flush buffered messages
      const flushed = this.buffer.flush();
      for (const msg of flushed) {
        if (Msg.isRequest(msg)) this.pendingRequests.add(msg.id);
        server.write(msg);
      }
      if (flushed.length > 0) log.info(`Flushed ${flushed.length} buffered message(s)`);

      // Final guard — server may have crashed during replay/flush
      if (this.state !== 'restarting' || this.server !== server) {
        if (this.state === 'restarting') this.scheduleRestart();
        return;
      }

      this.state = 'running';
      this.scheduler.reset();
      log.info('Server restarted successfully');
    } catch (err) {
      log.error('Restart failed:', err);
      this.server?.dispose();
      this.server = null;
      if (this.state === 'restarting') this.scheduleRestart();
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private sendProxyRequest(
    server: ChildServer,
    method: string,
    params: RequestMessage['params'],
    timeoutMs = 30_000,
  ): Promise<ResponseMessage> {
    const id = `__proxy:${this.proxySeq++}`;
    return new Promise<ResponseMessage>((resolve) => {
      const timer = setTimeout(() => {
        this.proxyCallbacks.delete(id);
        resolve({
          jsonrpc: '2.0',
          id,
          error: { code: -1, message: `Request ${method} timed out after ${timeoutMs}ms` },
        });
      }, timeoutMs);

      this.proxyCallbacks.set(id, (res) => {
        clearTimeout(timer);
        resolve(res);
      });

      server.write(createRequest(id, method, params));
    });
  }

  private resolveProxyCallbacks(message: string): void {
    for (const [id, cb] of this.proxyCallbacks) {
      cb({ jsonrpc: '2.0', id, error: { code: -1, message } });
    }
    this.proxyCallbacks.clear();
  }

  private errorPendingRequests(message: string): void {
    for (const id of this.pendingRequests) {
      this.sendErrorToClient(id, LSP_ERROR_CODES.InternalError, message);
    }
    this.pendingRequests.clear();
  }

  private respondToClient(id: number | string | null, result: ResponseMessage['result']): void {
    const response: ResponseMessage = { jsonrpc: '2.0', id, ...(result !== undefined && { result }) };
    this.writeToClient(response);
  }

  private sendErrorToClient(id: number | string | null, code: number, message: string): void {
    const response: ResponseMessage = { jsonrpc: '2.0', id, error: { code, message } };
    this.writeToClient(response);
  }

  private writeToClient(msg: Message): void {
    this.clientWriter.write(msg).catch((err) => {
      log.warn('Client write failed:', err);
    });
  }

  private cancelRestart(): void {
    this.scheduler.cancel();
    this.resolveProxyCallbacks('Restart cancelled');
    this.server?.dispose();
    this.server = null;
  }

  dispose(): void {
    if (this.state === 'stopped') return;
    this.state = 'stopped';
    this.cancelRestart();
    this.clientReader.dispose();
    log.info('Proxy shut down');
    this.resolveDone?.();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}
