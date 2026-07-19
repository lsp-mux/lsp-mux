import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as v from 'valibot';
import { StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node.js';
import { staticCapabilities } from './capabilities.ts';
import { analyzeClientCapabilities, injectProxyCapabilities } from './client-capabilities.ts';
import type { CompensationFlags } from './client-capabilities.ts';
import { createDiagnosticsCoordinator } from './diagnostics-coordinator.ts';
import type { DiagnosticsCoordinator } from './diagnostics-coordinator.ts';
import { rewriteDocSyncUri, rewriteDocSyncVersion } from './doc-sync.ts';
import * as docs from './document-tracker.ts';
import * as fw from './file-watcher.ts';
import { createLogger } from './logger.ts';
import type { Logger } from './logger.ts';
import type { ManagedServer, ServerState } from './managed-server.ts';
import { createManagedServer } from './managed-server.ts';
import { CancelParamsSchema, InitializeParamsSchema } from './protocol-schemas.ts';
import type { RestartPolicy } from './restart-scheduler.ts';
import type { Router } from './router.ts';
import { createRouter, extractUri } from './router.ts';
import { createServerMessageHandler } from './server-messages.ts';
import type { ServerMessageHandler } from './server-messages.ts';
import {
  Message as Msg,
  createNotification,
  documentSyncMethods,
  lspErrorCodes,
} from './types.ts';
import type {
  Message,
  NotificationMessage,
  RequestMessage,
  ResponseMessage,
  ServerConfig,
} from './types.ts';
import { normalizeFileUri } from './uri.ts';
import { WorkspaceWatcher } from './workspace-watcher.ts';

type ProxyState = 'idle' | 'running' | 'stopped';

export interface ProxyOptions {
  input?: NodeJS.ReadableStream;
  logger?: Logger | undefined;
  output?: NodeJS.WritableStream;
  restartPolicy?: Partial<RestartPolicy>;
  watcherExclude?: readonly string[];
  maxResyncBytes?: number;
  maxPendingEvents?: number;
}

/**
 * Multi-server LSP proxy.
 *
 * Sits between the client (stdio) and one or more child LSP servers.
 * Handles initialize/shutdown coordination, document state tracking,
 * message routing, diagnostics merging, file watching, and transparent
 * crash-restart.
 */
export class LspProxy {
  private readonly clientReader: StreamMessageReader;
  private readonly clientWriter: StreamMessageWriter;
  private readonly log: Logger;

  private state: ProxyState = 'idle';
  private compensations: CompensationFlags = {
    localFileWatching: true,
    proactivePullDiagnostics: true,
  };

  private documents: docs.DocumentMap = docs.empty();
  private watchRegistrations: fw.WatchRegistrations = fw.empty();
  private initParams: RequestMessage['params'];
  private workspaceRoot: string | undefined;
  private watcher: WorkspaceWatcher | undefined;

  private readonly servers: Map<string, ManagedServer>;
  private readonly router: Router;
  private readonly diagnostics: DiagnosticsCoordinator;
  private readonly serverMessages: ServerMessageHandler;
  private readonly proxyOptions: ProxyOptions | undefined;

  // Track which server owns each pending client request (used for cancel routing)
  private readonly requestRouting = new Map<number | string | null, string>();

  // Track which server originated each server-to-client request (for response routing)
  private readonly serverRequestRouting = new Map<number | string | null, string>();

  // Per-document version offset: added to client versions before forwarding to servers.
  // Bumped on resync so server versions stay monotonically increasing.
  private readonly versionOffsets = new Map<string, number>();

  private resolveDone?: () => void;

  constructor(serverConfigs: ReadonlyMap<string, ServerConfig>, options?: ProxyOptions) {
    this.clientReader = new StreamMessageReader(options?.input ?? process.stdin);
    this.clientWriter = new StreamMessageWriter(options?.output ?? process.stdout);
    this.log = options?.logger ?? createLogger();
    this.proxyOptions = options;

    this.servers = new Map<string, ManagedServer>();
    const serverEntries = [...serverConfigs].map(([name, config]) => ({ name, config }));

    for (const { name, config } of serverEntries) {
      this.servers.set(name, createManagedServer({
        name,
        config,
        callbacks: {
          onServerMessage: (msg) => {
            this.serverMessages.handleMessage(name, msg);
          },
          onPendingErrors: (ids, message) => {
            this.handlePendingErrors(name, ids, message);
          },
          onStateChange: (serverState) => {
            this.handleServerStateChange(name, serverState);
          },
          getDocuments: () => this.getDocumentsWithEffectiveVersions(),
        },
        log: this.log,
        restartPolicy: options?.restartPolicy,
      }));
    }

    this.router = createRouter(serverEntries);
    this.diagnostics = createDiagnosticsCoordinator({
      serversForUri: uri => this.router.serversForUri(uri),
      getServer: name => this.servers.get(name),
      isStopped: () => this.isStopped(),
      isProactivePull: () => this.compensations.proactivePullDiagnostics,
      getTrackedUris: () => this.documents.keys(),
      writeToClient: (msg) => { this.writeToClient(msg); },
      respondToClient: (id, result) => { this.respondToClient(id, result); },
      ackToServer: (name, id) => { this.ackToServer(name, id); },
      trackServerRequest: (id, name) => { this.serverRequestRouting.set(id, name); },
    }, this.log);
    this.serverMessages = createServerMessageHandler({
      delegate: {
        ackToServer: (name, id) => { this.ackToServer(name, id); },
        getWatchRegistrations: () => this.watchRegistrations,
        getWorkspaceRoot: () => this.workspaceRoot,
        isLocalFileWatching: () => this.compensations.localFileWatching,
        sendToServer: (name, msg) => { this.servers.get(name)?.send(msg); },
        setWatchRegistrations: (registrations) => { this.watchRegistrations = registrations; },
        trackServerRequest: (id, name) => { this.serverRequestRouting.set(id, name); },
        untrackClientRequest: (id) => { this.requestRouting.delete(id); },
        writeToClient: (msg) => { this.writeToClient(msg); },
      },
      diagnostics: this.diagnostics,
      serverConfigs,
      log: this.log,
    });
  }

  // ── Client → Server ──────────────────────────────────────────────────

  private logClientMessage(msg: Message): void {
    if (Msg.isRequest(msg)) {
      this.log.debug(`client → proxy: request ${msg.method} (id: ${String(msg.id)})`);
    } else if (Msg.isNotification(msg)) {
      this.log.debug(`client → proxy: notification ${msg.method}`);
    } else if (Msg.isResponse(msg)) {
      this.log.debug(`client → proxy: response (id: ${String(msg.id)})`);
    }
  }

  private handleStoppedMessage(msg: Message): void {
    if (Msg.isNotification(msg) && msg.method === 'exit') {
      this.clientReader.dispose();
      return;
    }
    if (Msg.isRequest(msg)) {
      this.sendErrorToClient(msg.id, lspErrorCodes.ServerNotInitialized, 'Server stopped');
    }
  }

  private handleClientMessage(msg: Message): void {
    this.logClientMessage(msg);

    if (Msg.isNotification(msg) && documentSyncMethods.has(msg.method)) {
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
      case 'stopped': {
        this.handleStoppedMessage(msg);
        return;
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
      this.sendErrorToClient(msg.id, lspErrorCodes.ServerNotInitialized, 'Not initialized');
    }
  }

  private async initializeAllServers(clientRequestId: number | string | null): Promise<void> {
    this.compensations = analyzeClientCapabilities(this.initParams);
    const { localFileWatching, proactivePullDiagnostics } = this.compensations;
    this.log.info(
      `Client capability compensation: localFileWatching=${String(localFileWatching)}, ` +
      `proactivePullDiagnostics=${String(proactivePullDiagnostics)}`,
    );

    // Servers check this to decide whether to use dynamic registration.
    const serverInitParams = injectProxyCapabilities(this.initParams, this.compensations);

    // Store init params on each server for lazy start — no spawning yet.
    for (const server of this.servers.values()) {
      server.setInitParams(serverInitParams);
    }

    this.respondToClient(clientRequestId, { capabilities: staticCapabilities });
    this.state = 'running';

    await this.resolveWorkspaceRoot();

    if (this.compensations.localFileWatching) {
      await this.startWorkspaceWatcher();
    }
  }

  /** Broadcast a message to every server that isn't idle. */
  private broadcastToActive(msg: Message): void {
    for (const server of this.servers.values()) {
      if (server.state !== 'idle') server.send(msg);
    }
  }

  /** Route a client response back to the server that issued the request. */
  private routeClientResponse(msg: ResponseMessage): void {
    const targetServer = this.serverRequestRouting.get(msg.id);
    this.serverRequestRouting.delete(msg.id);
    if (targetServer) {
      this.servers.get(targetServer)?.send(msg);
    }
  }

  private handleCancelRequest(msg: NotificationMessage): void {
    const result = v.safeParse(CancelParamsSchema, msg.params);
    if (result.success) {
      const { id } = result.output;
      let isCancelled = false;
      for (const server of this.servers.values()) {
        if (server.cancelBuffered(id)) isCancelled = true;
      }
      if (isCancelled) {
        this.sendErrorToClient(id, lspErrorCodes.RequestCancelled, 'Request cancelled');
        this.requestRouting.delete(id);
        return;
      }
    }
    // Not buffered — forward for in-flight cancellation (skip idle servers)
    this.broadcastToActive(msg);
  }

  private handleDocumentSync(msg: NotificationMessage): void {
    const rawUri = extractUri(msg);
    const uri = rawUri ? normalizeFileUri(rawUri) : undefined;
    const normalized = uri && uri !== rawUri
      ? rewriteDocSyncUri(msg, uri)
      : msg;

    // Reset version offset on open/close — client version is authoritative
    const isOpenOrClose =
      msg.method === 'textDocument/didOpen' || msg.method === 'textDocument/didClose';
    if (isOpenOrClose && uri) this.versionOffsets.delete(uri);

    const rewritten = this.applyVersionOffset(normalized, uri);
    for (const name of this.router.serversForUri(uri)) {
      this.servers.get(name)?.send(rewritten);
    }

    this.diagnostics.maybePullAfterSync(msg, uri);
  }

  private handleRunningNotification(msg: NotificationMessage): void {
    switch (msg.method) {
      case 'exit': {
        this.broadcastToActive(msg);
        this.dispose();
        return;
      }
      case 'initialized': {
        for (const server of this.servers.values()) server.sendInitialized();
        this.log.info('LSP handshake complete');
        return;
      }
      case '$/cancelRequest': {
        this.handleCancelRequest(msg);
        return;
      }
    }
    if (documentSyncMethods.has(msg.method)) {
      this.handleDocumentSync(msg);
      return;
    }
    this.broadcastToActive(msg);
  }

  /** Route a generic client request to the primary server for its document. */
  private routeRequestToPrimary(msg: RequestMessage): void {
    const uri = extractUri(msg);
    const primaryName = this.router.primaryForUri(uri);
    const primary = primaryName ? this.servers.get(primaryName) : undefined;
    if (primary) {
      this.requestRouting.set(msg.id, primary.name);
      if (!primary.send(msg)) {
        this.sendErrorToClient(msg.id, lspErrorCodes.InternalError, 'Server unavailable');
        this.requestRouting.delete(msg.id);
      }
    } else {
      this.sendErrorToClient(msg.id, lspErrorCodes.InternalError, 'No servers available');
    }
  }

  private handleRunningRequest(msg: RequestMessage): void {
    switch (msg.method) {
      case 'shutdown': {
        void this.shutdownAllServers(msg.id);
        return;
      }
      case 'textDocument/diagnostic': {
        void this.diagnostics.handleClientPull(msg);
        return;
      }
    }
    this.routeRequestToPrimary(msg);
  }

  private handleRunningMessage(msg: Message): void {
    if (Msg.isResponse(msg)) {
      this.routeClientResponse(msg);
      return;
    }
    if (Msg.isNotification(msg)) {
      this.handleRunningNotification(msg);
      return;
    }
    if (Msg.isRequest(msg)) {
      this.handleRunningRequest(msg);
    }
  }

  private async shutdownAllServers(clientRequestId: number | string | null): Promise<void> {
    for (const server of this.servers.values()) {
      if (server.state === 'idle') continue;
      await server.shutdown();
    }
    /* eslint-disable-next-line unicorn/no-null --
       The LSP shutdown response requires an explicit null result. */
    this.respondToClient(clientRequestId, null);
    this.state = 'stopped';
  }

  // ── Server → Client ──────────────────────────────────────────────────

  private handlePendingErrors(
    _serverName: string,
    ids: ReadonlySet<number | string | null>,
    message: string,
  ): void {
    for (const id of ids) {
      this.sendErrorToClient(id, lspErrorCodes.InternalError, message);
      this.requestRouting.delete(id);
    }
  }

  private handleServerStateChange(serverName: string, serverState: ServerState): void {
    this.log.debug(`${serverName}: state → ${serverState}`);
    if (serverState === 'restarting' || serverState === 'starting') {
      this.diagnostics.clearServer(serverName);
      this.watchRegistrations = fw.unregisterServer(this.watchRegistrations, serverName);
    }

    const isAllStopped = this.servers.values().every(server => server.state === 'stopped');
    if (isAllStopped && this.state === 'running') {
      this.log.error('All servers stopped — proxy stopping');
      this.dispose();
    }
  }

  // ── Workspace Root ───────────────────────────────────────────────────

  private async resolveWorkspaceRoot(): Promise<void> {
    const parsed = v.safeParse(InitializeParamsSchema, this.initParams);
    const rootUri = parsed.success ? parsed.output.rootUri : undefined;
    if (!rootUri) return;

    try {
      const root = fileURLToPath(rootUri);
      await stat(root);
      this.workspaceRoot = root;
    } catch {
      // Malformed URI or nonexistent root — ignore
    }
  }

  // ── File Watching ─────────────────────────────────────────────────────

  private async startWorkspaceWatcher(): Promise<void> {
    if (!this.workspaceRoot) return;

    this.watcher = new WorkspaceWatcher(
      {
        log: this.log,
        workspaceRoot: this.workspaceRoot,
        watcherExclude: this.proxyOptions?.watcherExclude,
        maxResyncBytes: this.proxyOptions?.maxResyncBytes,
        maxPendingEvents: this.proxyOptions?.maxPendingEvents,
      },
      {
        isStopped: () => this.isStopped(),
        getDocument: uri => this.documents.get(uri),
        matchEvent: (relativePath, changeType, uri) =>
          fw.matchEvent(this.watchRegistrations, relativePath, changeType, uri),
        resyncDocument: (uri, clientVersion, text) => {
          const offset = (this.versionOffsets.get(uri) ?? 0) + 1;
          this.versionOffsets.set(uri, offset);
          const serverVersion = clientVersion + offset;
          this.documents = docs.trackChange(this.documents, {
            textDocument: { uri, version: clientVersion },
            contentChanges: [{ text }],
          });
          const notification = createNotification('textDocument/didChange', {
            textDocument: { uri, version: serverVersion },
            contentChanges: [{ text }],
          });
          for (const name of this.router.serversForUri(uri)) {
            this.servers.get(name)?.send(notification);
          }
        },
        sendWatchedFilesEvent: (serverName, changes) => {
          this.servers.get(serverName)?.send(
            createNotification('workspace/didChangeWatchedFiles', { changes }),
          );
        },
      },
    );
    await this.watcher.start();
  }

  // ── Version Offsets ──────────────────────────────────────────────────

  /** Apply this document's resync version offset to a sync notification, if any. */
  private applyVersionOffset(msg: NotificationMessage, uri: string | undefined): Message {
    const offset = uri ? this.versionOffsets.get(uri) : undefined;
    return offset ? rewriteDocSyncVersion(msg, offset) : msg;
  }

  /** Get documents with effective versions (client version + offset) for replay. */
  private getDocumentsWithEffectiveVersions(): readonly import('./types.ts').TrackedDocument[] {
    return docs.toArray(this.documents).map((doc) => {
      const offset = this.versionOffsets.get(doc.uri) ?? 0;
      return offset > 0 ? { ...doc, version: doc.version + offset } : doc;
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  /** Safe check that avoids TS narrowing issues across async boundaries. */
  private isStopped(): boolean { return this.state === 'stopped'; }

  private ackToServer(serverName: string, requestId: number | string | null): void {
    /* eslint-disable-next-line unicorn/no-null --
       A JSON-RPC ack response requires an explicit null result. */
    const response: ResponseMessage = { jsonrpc: '2.0', id: requestId, result: null };
    this.servers.get(serverName)?.send(response);
  }

  private respondToClient(id: number | string | null, result: ResponseMessage['result']): void {
    const response: ResponseMessage = {
      jsonrpc: '2.0',
      id,
      ...(result !== undefined && { result }),
    };
    this.writeToClient(response);
  }

  private sendErrorToClient(id: number | string | null, code: number, message: string): void {
    const response: ResponseMessage = { jsonrpc: '2.0', id, error: { code, message } };
    this.writeToClient(response);
  }

  private writeToClient(msg: Message): void {
    /* eslint-disable-next-line unicorn/prefer-await --
       Called from the synchronous clientReader.listen dispatch; fire-and-
       forget so message processing isn't blocked on flush. Log failures. */
    this.clientWriter.write(msg).catch((error: unknown) => {
      this.log.warn('Client write failed:', error);
    });
  }

  // ── Lifecycle / Public API ───────────────────────────────────────────

  get isWatcherDegraded(): boolean { return this.watcher?.isDegraded ?? false; }

  start(): Promise<void> {
    this.log.info('Proxy starting');
    this.clientReader.listen((msg) => {
      this.handleClientMessage(msg);
    });
    this.clientReader.onError((err) => {
      this.log.error('Client reader error:', err);
    });
    this.clientReader.onClose(() => {
      this.log.info('Client connection closed');
      this.dispose();
    });
    return new Promise((resolve) => {
      this.resolveDone = resolve;
    });
  }

  dispose(): void {
    if (this.state === 'stopped') return;
    this.state = 'stopped';
    this.watcher?.dispose();
    this.watcher = undefined;
    for (const server of this.servers.values()) server.dispose();
    this.clientReader.dispose();
    this.log.info('Proxy shut down');
    this.resolveDone?.();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}
