import { StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node.js';
import type { Message, RequestMessage, ResponseMessage, ServerConfig } from './types.js';
import * as v from 'valibot';
import { Message as Msg, createNotification, noop, DOCUMENT_SYNC_METHODS, LSP_ERROR_CODES } from './types.js';
import { createManagedServer } from './managed-server.js';
import type { ManagedServer, ServerState } from './managed-server.js';
import { createRouter, extractUri } from './router.js';
import type { Router } from './router.js';
import { mergeCapabilities } from './capabilities.js';
import * as diag from './diagnostics-store.js';
import * as docs from './document-tracker.js';
import type { RestartPolicy } from './restart-scheduler.js';
import { log } from './logger.js';

const CancelParamsSchema = v.object({
  id: v.union([v.number(), v.string()]),
});

const PublishDiagnosticsSchema = v.object({
  uri: v.string(),
  diagnostics: v.array(v.unknown()),
});

const InitializeResultSchema = v.object({
  capabilities: v.record(v.string(), v.unknown()),
});

type ProxyState = 'idle' | 'running' | 'stopped';

export interface ProxyOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  restartPolicy?: Partial<RestartPolicy>;
}

/**
 * Multi-server LSP proxy.
 *
 * Sits between the client (stdio) and one or more child LSP servers.
 * Handles initialize/shutdown coordination, document state tracking,
 * message routing, diagnostics merging, and transparent crash-restart.
 */
export class LspProxy {
  private readonly clientReader: StreamMessageReader;
  private readonly clientWriter: StreamMessageWriter;

  private state: ProxyState = 'idle';
  private documents: docs.DocumentMap = docs.empty();
  private diagnosticsStore: diag.DiagnosticsStore = diag.empty();
  private initParams: RequestMessage['params'];
  private readonly servers: Map<string, ManagedServer>;
  private readonly router: Router;

  // Track which server owns each pending client request (used for cancel routing in M3+)
  private readonly requestRouting = new Map<number | string | null, string>();

  private resolveDone?: () => void;

  constructor(serverConfigs: ReadonlyMap<string, ServerConfig>, options?: ProxyOptions) {
    this.clientReader = new StreamMessageReader(options?.input ?? process.stdin);
    this.clientWriter = new StreamMessageWriter(options?.output ?? process.stdout);

    this.servers = new Map<string, ManagedServer>();
    const serverEntries = [...serverConfigs].map(([name, config]) => ({ name, config }));

    for (const { name, config } of serverEntries) {
      this.servers.set(name, createManagedServer(name, config, {
        onServerMessage: (msg) => { this.handleServerMessage(name, msg); },
        onPendingErrors: (ids, message) => { this.handlePendingErrors(name, ids, message); },
        onStateChange: (serverState) => { this.handleServerStateChange(name, serverState); },
        getDocuments: () => docs.toArray(this.documents),
      }, options?.restartPolicy));
    }

    this.router = createRouter(serverEntries);
  }

  start(): Promise<void> {
    log.info('Proxy starting');
    this.clientReader.listen((msg) => {
      this.handleClientMessage(msg);
    });
    this.clientReader.onError((err) => {
      log.error('Client reader error:', err);
    });
    this.clientReader.onClose(() => {
      log.info('Client connection closed');
      this.dispose();
    });
    return new Promise((resolve) => {
      this.resolveDone = resolve;
    });
  }

  // ── Client → Server ──────────────────────────────────────────────────

  private handleClientMessage(msg: Message): void {
    if (Msg.isNotification(msg) && DOCUMENT_SYNC_METHODS.has(msg.method)) {
      this.documents = docs.apply(this.documents, msg.method, msg.params);
    }

    switch (this.state) {
      case 'idle': {
        this.handleIdleMessage(msg);
        return;
      }
      case 'running': {
        this.handleRunningMessage(msg);
        return;
      }
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
      void this.initializeAllServers(msg.id);
      return;
    }
    if (Msg.isRequest(msg)) {
      this.sendErrorToClient(msg.id, LSP_ERROR_CODES.ServerNotInitialized, 'Not initialized');
    }
  }

  private async initializeAllServers(clientRequestId: number | string | null): Promise<void> {
    const allCapabilities: Record<string, unknown>[] = [];
    const initialized: ManagedServer[] = [];

    for (const [name, server] of this.servers) {
      const response = await server.initialize(this.initParams);

      if (response.error) {
        log.error(`${name}: initialize failed — ${response.error.message}`);
        this.sendErrorToClient(clientRequestId, LSP_ERROR_CODES.InternalError,
          `Server ${name} failed to initialize: ${response.error.message}`);
        this.state = 'stopped';
        // Send clean shutdown to servers that already initialized (parallel to avoid N*30s timeout)
        await Promise.allSettled(initialized.map(s => s.shutdown().catch(noop)));
        for (const s of this.servers.values()) s.dispose();
        return;
      }

      initialized.push(server);
      const parsed = v.safeParse(InitializeResultSchema, response.result);
      if (parsed.success) {
        allCapabilities.push(parsed.output.capabilities);
      }
    }

    this.respondToClient(clientRequestId, {
      capabilities: mergeCapabilities(allCapabilities),
    });
    this.state = 'running';
  }

  private handleRunningMessage(msg: Message): void {
    if (Msg.isRequest(msg) && msg.method === 'shutdown') {
      void this.shutdownAllServers(msg.id);
      return;
    }

    if (Msg.isNotification(msg) && msg.method === 'exit') {
      for (const server of this.servers.values()) server.send(msg);
      this.dispose();
      return;
    }

    if (Msg.isNotification(msg) && msg.method === 'initialized') {
      for (const server of this.servers.values()) server.sendInitialized();
      log.info('LSP handshake complete');
      return;
    }

    if (Msg.isNotification(msg) && DOCUMENT_SYNC_METHODS.has(msg.method)) {
      const uri = extractUri(msg);
      for (const name of this.router.serversForUri(uri)) {
        this.servers.get(name)?.send(msg);
      }
      return;
    }

    if (Msg.isNotification(msg) && msg.method === '$/cancelRequest') {
      const result = v.safeParse(CancelParamsSchema, msg.params);
      if (result.success) {
        const { id } = result.output;
        let cancelled = false;
        for (const server of this.servers.values()) {
          if (server.cancelBuffered(id)) cancelled = true;
        }
        if (cancelled) {
          this.sendErrorToClient(id, LSP_ERROR_CODES.RequestCancelled, 'Request cancelled');
          this.requestRouting.delete(id);
          return;
        }
      }
      // Not buffered — forward for in-flight cancellation
      for (const server of this.servers.values()) server.send(msg);
      return;
    }

    if (Msg.isRequest(msg)) {
      const uri = extractUri(msg);
      const primaryName = this.router.primaryForUri(uri);
      const primary = primaryName ? this.servers.get(primaryName) : undefined;
      if (primary) {
        this.requestRouting.set(msg.id, primary.name);
        if (!primary.send(msg)) {
          this.sendErrorToClient(msg.id, LSP_ERROR_CODES.InternalError, 'Server unavailable');
          this.requestRouting.delete(msg.id);
        }
      }
      else {
        this.sendErrorToClient(msg.id, LSP_ERROR_CODES.InternalError, 'No servers available');
      }
      return;
    }

    for (const server of this.servers.values()) server.send(msg);
  }

  private async shutdownAllServers(clientRequestId: number | string | null): Promise<void> {
    for (const server of this.servers.values()) {
      await server.shutdown();
    }
    this.respondToClient(clientRequestId, null);
    this.state = 'stopped';
  }

  // ── Server → Client ──────────────────────────────────────────────────

  private handleServerMessage(serverName: string, msg: Message): void {
    if (Msg.isNotification(msg) && msg.method === 'textDocument/publishDiagnostics') {
      const result = v.safeParse(PublishDiagnosticsSchema, msg.params);
      if (result.success) {
        this.diagnosticsStore = diag.update(this.diagnosticsStore, serverName, result.output.uri, result.output.diagnostics);
        this.publishMergedDiagnostics(result.output.uri);
        return;
      }
    }

    if (Msg.isResponse(msg) && msg.id !== null) {
      this.requestRouting.delete(msg.id);
    }
    this.writeToClient(msg);
  }

  private handlePendingErrors(_serverName: string, ids: ReadonlySet<number | string | null>, message: string): void {
    for (const id of ids) {
      this.sendErrorToClient(id, LSP_ERROR_CODES.InternalError, message);
      this.requestRouting.delete(id);
    }
  }

  private handleServerStateChange(serverName: string, serverState: ServerState): void {
    if (serverState === 'restarting') {
      const { store, affectedUris } = diag.clearServer(this.diagnosticsStore, serverName);
      this.diagnosticsStore = store;
      for (const uri of affectedUris) this.publishMergedDiagnostics(uri);
    }

    const allStopped = [...this.servers.values()].every(s => s.state === 'stopped');
    if (allStopped && this.state === 'running') {
      log.error('All servers stopped — proxy stopping');
      this.dispose();
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private publishMergedDiagnostics(uri: string): void {
    const merged = diag.merge(this.diagnosticsStore, uri);
    this.writeToClient(createNotification('textDocument/publishDiagnostics', {
      uri,
      diagnostics: merged,
    }));
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
    this.clientWriter.write(msg).catch((err: unknown) => {
      log.warn('Client write failed:', err);
    });
  }

  dispose(): void {
    if (this.state === 'stopped') return;
    this.state = 'stopped';
    for (const server of this.servers.values()) server.dispose();
    this.clientReader.dispose();
    log.info('Proxy shut down');
    this.resolveDone?.();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}
