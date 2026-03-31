import { stat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node.js';
import type { Message, NotificationMessage, RequestMessage, ResponseMessage, ServerConfig } from './types.js';
import * as v from 'valibot';
import { Message as Msg, createNotification, DOCUMENT_SYNC_METHODS, LSP_ERROR_CODES, LSP_MESSAGE_TYPE } from './types.js';
import { createManagedServer } from './managed-server.js';
import type { ManagedServer, ServerState } from './managed-server.js';
import { createRouter, extractUri } from './router.js';
import type { Router } from './router.js';
import { isPlainObject, STATIC_CAPABILITIES } from './capabilities.js';
import { normalizeFileUri } from './uri.js';
import { analyzeClientCapabilities } from './client-capabilities.js';
import type { CompensationFlags } from './client-capabilities.js';
import * as diag from './diagnostics-store.js';
import * as docs from './document-tracker.js';
import * as fw from './file-watcher.js';
import type { RestartPolicy } from './restart-scheduler.js';
import { WorkspaceWatcher } from './workspace-watcher.js';
import { createLogger } from './logger.js';
import type { Logger } from './logger.js';

const CancelParamsSchema = v.object({
  id: v.union([v.number(), v.string()]),
});

const PublishDiagnosticsSchema = v.object({
  uri: v.string(),
  diagnostics: v.array(v.unknown()),
});

const InitializeParamsSchema = v.object({
  rootUri: v.optional(v.nullable(v.string())),
});

const RegisterCapabilitySchema = v.object({
  registrations: v.array(v.object({
    id: v.string(),
    method: v.string(),
    registerOptions: v.optional(v.unknown()),
  })),
});

const UnregisterCapabilitySchema = v.object({
  unregisterations: v.array(v.object({
    id: v.string(),
    method: v.string(),
  })),
});

const WorkspaceConfigurationSchema = v.object({
  items: v.array(v.object({
    scopeUri: v.optional(v.nullable(v.string())),
    section: v.optional(v.nullable(v.string())),
  })),
});

const LogMessageSchema = v.object({
  type: v.pipe(
    v.number(),
    v.transform((n): 'error' | 'warn' | 'info' | 'debug' => {
      if (n === LSP_MESSAGE_TYPE.Error) return 'error';
      if (n === LSP_MESSAGE_TYPE.Warning) return 'warn';
      return n === LSP_MESSAGE_TYPE.Info ? 'info' : 'debug';
    }),
  ),
  message: v.string(),
});

/**
 * Ensures child servers see capabilities the proxy handles.
 *
 * - `didChangeConfiguration` is always injected — the proxy manages per-server
 *   settings delivery regardless of client support.
 * - `didChangeWatchedFiles` is only injected when the proxy compensates for a
 *   client that lacks native file watching (localFileWatching).
 */
const injectProxyCapabilities = (params: unknown, compensations: CompensationFlags): object => {
  const base = isPlainObject(params) ? params : {};
  const caps = isPlainObject(base['capabilities']) ? base['capabilities'] : {};
  const workspace = isPlainObject(caps['workspace']) ? caps['workspace'] : {};
  const dcc = isPlainObject(workspace['didChangeConfiguration'])
    ? workspace['didChangeConfiguration']
    : {};

  const workspaceOverrides: Record<string, unknown> = {
    ...workspace,
    didChangeConfiguration: { ...dcc, dynamicRegistration: true },
  };

  if (compensations.localFileWatching) {
    const dcwf = isPlainObject(workspace['didChangeWatchedFiles'])
      ? workspace['didChangeWatchedFiles']
      : {};
    workspaceOverrides['didChangeWatchedFiles'] = { ...dcwf, dynamicRegistration: true };
  }

  return {
    ...base,
    capabilities: {
      ...caps,
      workspace: workspaceOverrides,
    },
  };
};

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
  private compensations: CompensationFlags = { localFileWatching: true, proactivePullDiagnostics: true };
  private documents: docs.DocumentMap = docs.empty();
  private diagnosticsStore: diag.DiagnosticsStore = diag.empty();
  private watchRegistrations: fw.WatchRegistrations = fw.empty();
  private initParams: RequestMessage['params'];
  private workspaceRoot: string | null = null;
  private watcher: WorkspaceWatcher | null = null;

  get isWatcherDegraded(): boolean { return this.watcher?.isDegraded ?? false; }

  private readonly servers: Map<string, ManagedServer>;
  private readonly serverConfigs: ReadonlyMap<string, ServerConfig>;
  private readonly router: Router;
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
    this.serverConfigs = serverConfigs;

    this.servers = new Map<string, ManagedServer>();
    const serverEntries = [...serverConfigs].map(([name, config]) => ({ name, config }));

    for (const { name, config } of serverEntries) {
      this.servers.set(name, createManagedServer(name, config, {
        onServerMessage: (msg) => {
          this.handleServerMessage(name, msg);
        },
        onPendingErrors: (ids, message) => {
          this.handlePendingErrors(name, ids, message);
        },
        onStateChange: (serverState) => {
          this.handleServerStateChange(name, serverState);
        },
        getDocuments: () => this.getDocumentsWithEffectiveVersions(),
      }, this.log, options?.restartPolicy));
    }

    this.router = createRouter(serverEntries);
  }

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

  // ── Client → Server ──────────────────────────────────────────────────

  private handleClientMessage(msg: Message): void {
    if (Msg.isRequest(msg)) this.log.debug(`client → proxy: request ${msg.method} (id: ${String(msg.id)})`);
    else if (Msg.isNotification(msg)) this.log.debug(`client → proxy: notification ${msg.method}`);
    else if (Msg.isResponse(msg)) this.log.debug(`client → proxy: response (id: ${String(msg.id)})`);

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
    this.compensations = analyzeClientCapabilities(this.initParams);
    this.log.info(`Client capability compensation: localFileWatching=${String(this.compensations.localFileWatching)}, proactivePullDiagnostics=${String(this.compensations.proactivePullDiagnostics)}`);

    // Servers check this to decide whether to use dynamic registration.
    const serverInitParams = injectProxyCapabilities(this.initParams, this.compensations);

    // Store init params on each server for lazy start — no spawning yet.
    for (const server of this.servers.values()) {
      server.setInitParams(serverInitParams);
    }

    this.respondToClient(clientRequestId, { capabilities: STATIC_CAPABILITIES });
    this.state = 'running';

    await this.resolveWorkspaceRoot();

    if (this.compensations.localFileWatching) {
      await this.startWorkspaceWatcher();
    }
  }

  private handleRunningMessage(msg: Message): void {
    if (Msg.isRequest(msg) && msg.method === 'shutdown') {
      void this.shutdownAllServers(msg.id);
      return;
    }

    if (Msg.isNotification(msg) && msg.method === 'exit') {
      for (const server of this.servers.values()) {
        if (server.state !== 'idle') server.send(msg);
      }
      this.dispose();
      return;
    }

    if (Msg.isNotification(msg) && msg.method === 'initialized') {
      for (const server of this.servers.values()) server.sendInitialized();
      this.log.info('LSP handshake complete');
      return;
    }

    if (Msg.isNotification(msg) && DOCUMENT_SYNC_METHODS.has(msg.method)) {
      const rawUri = extractUri(msg);
      const uri = rawUri ? normalizeFileUri(rawUri) : undefined;
      const normalized = uri && uri !== rawUri
        ? this.rewriteDocSyncUri(msg, uri)
        : msg;

      // Reset version offset on open/close — client version is authoritative
      if (msg.method === 'textDocument/didOpen' || msg.method === 'textDocument/didClose') {
        if (uri) this.versionOffsets.delete(uri);
      }

      const rewritten = this.rewriteDocSyncVersion(normalized, uri);
      for (const name of this.router.serversForUri(uri)) {
        this.servers.get(name)?.send(rewritten);
      }

      // Pull diagnostics from servers that use the pull model (e.g., ESLint).
      // Only needed when the client lacks native pull diagnostic support —
      // converts pull results to push notifications the client can consume.
      if (this.compensations.proactivePullDiagnostics && uri && msg.method !== 'textDocument/didClose') {
        const allStarting = this.router.serversForUri(uri)
          .every((n) => {
            const s = this.servers.get(n)?.state;
            return s === 'starting' || s === 'idle';
          });
        if (allStarting) {
          setTimeout(() => {
            if (this.isStopped()) return;
            void this.pullDiagnostics(uri);
          }, 3000);
        }
        else {
          void this.pullDiagnostics(uri);
        }
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
      // Not buffered — forward for in-flight cancellation (skip idle servers)
      for (const server of this.servers.values()) {
        if (server.state !== 'idle') server.send(msg);
      }
      return;
    }

    // Route client responses to the server that originated the request
    if (Msg.isResponse(msg)) {
      const targetServer = this.serverRequestRouting.get(msg.id);
      this.serverRequestRouting.delete(msg.id);
      if (targetServer) {
        this.servers.get(targetServer)?.send(msg);
      }
      return;
    }

    if (Msg.isRequest(msg) && msg.method === 'textDocument/diagnostic') {
      void this.handleDiagnosticPull(msg);
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

    // Fallback: broadcast to non-idle servers only
    for (const server of this.servers.values()) {
      if (server.state !== 'idle') server.send(msg);
    }
  }

  private async shutdownAllServers(clientRequestId: number | string | null): Promise<void> {
    for (const server of this.servers.values()) {
      if (server.state === 'idle') continue;
      await server.shutdown();
    }
    this.respondToClient(clientRequestId, null);
    this.state = 'stopped';
  }

  // ── Server → Client ──────────────────────────────────────────────────

  private handleServerMessage(serverName: string, msg: Message): void {
    if (Msg.isRequest(msg)) this.log.debug(`${serverName} → proxy: request ${msg.method}`);
    else if (Msg.isResponse(msg)) this.log.debug(`${serverName} → proxy: response (id: ${String(msg.id)})`);
    else if (Msg.isNotification(msg)) this.logServerNotification(serverName, msg);

    if (Msg.isNotification(msg) && msg.method === 'textDocument/publishDiagnostics') {
      const result = v.safeParse(PublishDiagnosticsSchema, msg.params);
      if (result.success) {
        const uri = normalizeFileUri(result.output.uri);
        this.diagnosticsStore = diag.update(this.diagnosticsStore, serverName, uri, result.output.diagnostics);
        this.publishMergedDiagnostics(uri);
        return;
      }
    }

    // workspace/diagnostic/refresh: when compensating, re-pull diagnostics
    // for tracked documents; otherwise forward to client so it re-pulls.
    if (Msg.isRequest(msg) && msg.method === 'workspace/diagnostic/refresh') {
      if (this.compensations.proactivePullDiagnostics) {
        this.ackToServer(serverName, msg.id);
        for (const uri of this.documents.keys()) {
          void this.pullDiagnostics(uri);
        }
        return;
      }
      // Forward to client — track for response routing
      this.serverRequestRouting.set(msg.id, serverName);
      this.writeToClient(msg);
      return;
    }

    // Intercept workspace/configuration — respond with server-specific settings
    if (Msg.isRequest(msg) && msg.method === 'workspace/configuration') {
      const settings = this.serverConfigs.get(serverName)?.settings;
      if (settings) {
        this.handleWorkspaceConfiguration(serverName, msg, settings);
        return;
      }
    }

    // Intercept client/registerCapability for file watching
    if (Msg.isRequest(msg) && msg.method === 'client/registerCapability') {
      this.handleRegisterCapability(serverName, msg);
      return;
    }

    // Intercept client/unregisterCapability for file watching
    if (Msg.isRequest(msg) && msg.method === 'client/unregisterCapability') {
      this.handleUnregisterCapability(serverName, msg);
      return;
    }

    if (Msg.isResponse(msg) && msg.id !== null) {
      this.requestRouting.delete(msg.id);
    }

    // Track server-to-client requests so the client's response can be routed back
    if (Msg.isRequest(msg)) {
      this.serverRequestRouting.set(msg.id, serverName);
    }

    this.writeToClient(msg);
  }

  private handleRegisterCapability(serverName: string, msg: RequestMessage): void {
    const parsed = v.safeParse(RegisterCapabilitySchema, msg.params);
    if (!parsed.success) {
      this.writeToClient(msg);
      return;
    }

    const otherRegs: typeof parsed.output.registrations = [];
    let handledCount = 0;

    for (const reg of parsed.output.registrations) {
      if (reg.method === 'workspace/didChangeWatchedFiles' && this.compensations.localFileWatching) {
        const opts = v.safeParse(fw.RegisterOptionsSchema, reg.registerOptions);
        if (opts.success) {
          this.watchRegistrations = fw.register(
            this.watchRegistrations, serverName, reg.id, opts.output,
            this.workspaceRoot ?? undefined,
          );
          handledCount++;
          this.log.info(`${serverName}: registered file watcher ${reg.id}`);
          continue;
        }
        // Malformed watcher registration — log and count as handled (don't forward)
        this.log.warn(`${serverName}: malformed watcher registration ${reg.id} — skipping`);
        handledCount++;
        continue;
      }
      // The proxy manages config delivery — ack didChangeConfiguration registrations
      // directly so they don't reach the client (which may not support them).
      if (reg.method === 'workspace/didChangeConfiguration') {
        handledCount++;
        continue;
      }
      otherRegs.push(reg);
    }

    if (otherRegs.length > 0) {
      // Forward non-watcher registrations to client, track for response routing
      const filtered: RequestMessage = { ...msg, params: { registrations: otherRegs } };
      this.serverRequestRouting.set(msg.id, serverName);
      this.writeToClient(filtered);
    }
    else if (handledCount > 0) {
      // All registrations were file watchers — ack to server directly
      this.ackToServer(serverName, msg.id);
    }
    else {
      // Nothing matched — forward original
      this.writeToClient(msg);
    }
  }

  private handleUnregisterCapability(serverName: string, msg: RequestMessage): void {
    const parsed = v.safeParse(UnregisterCapabilitySchema, msg.params);
    if (!parsed.success) {
      this.writeToClient(msg);
      return;
    }

    // LSP spec misspells "unregisterations" (sic)
    const otherUnregs: typeof parsed.output.unregisterations = [];
    let handledCount = 0;

    for (const unreg of parsed.output.unregisterations) {
      if (unreg.method === 'workspace/didChangeWatchedFiles' && this.compensations.localFileWatching) {
        this.watchRegistrations = fw.unregister(this.watchRegistrations, unreg.id);
        handledCount++;
        this.log.info(`${serverName}: unregistered file watcher ${unreg.id}`);
      }
      else {
        otherUnregs.push(unreg);
      }
    }

    if (otherUnregs.length > 0) {
      const filtered: RequestMessage = { ...msg, params: { unregisterations: otherUnregs } };
      this.serverRequestRouting.set(msg.id, serverName);
      this.writeToClient(filtered);
    }
    else if (handledCount > 0) {
      this.ackToServer(serverName, msg.id);
    }
    else {
      this.writeToClient(msg);
    }
  }

  private handleWorkspaceConfiguration(
    serverName: string,
    msg: RequestMessage,
    settings: Record<string, unknown>,
  ): void {
    const parsed = v.safeParse(WorkspaceConfigurationSchema, msg.params);
    if (!parsed.success) {
      this.log.warn(`${serverName}: malformed workspace/configuration request — responding with empty array`);
      const response: ResponseMessage = { jsonrpc: '2.0', id: msg.id, result: [] };
      this.servers.get(serverName)?.send(response);
      return;
    }

    const workspaceFolder = this.workspaceRoot
      ? { uri: pathToFileURL(this.workspaceRoot).href, name: '' }
      : undefined;

    const result = parsed.output.items.map((item) => {
      const section = item.section;
      if (section && section in settings) return settings[section];
      return { ...settings, workspaceFolder };
    });

    const response: ResponseMessage = { jsonrpc: '2.0', id: msg.id, result };
    this.servers.get(serverName)?.send(response);
  }

  private handlePendingErrors(_serverName: string, ids: ReadonlySet<number | string | null>, message: string): void {
    for (const id of ids) {
      this.sendErrorToClient(id, LSP_ERROR_CODES.InternalError, message);
      this.requestRouting.delete(id);
    }
  }

  private handleServerStateChange(serverName: string, serverState: ServerState): void {
    this.log.debug(`${serverName}: state → ${serverState}`);
    if (serverState === 'restarting' || serverState === 'starting') {
      const { store, affectedUris } = diag.clearServer(this.diagnosticsStore, serverName);
      this.diagnosticsStore = store;
      for (const uri of affectedUris) this.publishMergedDiagnostics(uri);

      this.watchRegistrations = fw.unregisterServer(this.watchRegistrations, serverName);
    }

    const allStopped = [...this.servers.values()].every(s => s.state === 'stopped');
    if (allStopped && this.state === 'running') {
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
      const exists = await stat(root).then(() => true, () => false);
      if (exists) this.workspaceRoot = root;
    }
    catch {
      // Malformed URI — ignore
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

  // ── URI / Version Rewriting ──────────────────────────────────────────

  /** Rewrite the textDocument.uri in a document sync notification to a
   *  normalized form. Used when the client sends non-standard file URIs. */
  private rewriteDocSyncUri(msg: NotificationMessage, normalizedUri: string): NotificationMessage {
    const params = msg.params;
    if (!isPlainObject(params)) return msg;
    const td = params['textDocument'];
    if (!isPlainObject(td)) return msg;
    return createNotification(msg.method, {
      ...params,
      textDocument: { ...td, uri: normalizedUri },
    });
  }

  /** Rewrite the textDocument.version in a document sync notification if a
   *  version offset exists for the URI (due to prior resync). */
  private rewriteDocSyncVersion(msg: NotificationMessage, uri: string | undefined): Message {
    if (!uri) return msg;
    const offset = this.versionOffsets.get(uri);
    if (!offset) return msg;

    const params = msg.params;
    if (!isPlainObject(params)) return msg;
    const td = params['textDocument'];
    if (!isPlainObject(td) || typeof td['version'] !== 'number') return msg;

    // Spread creates new objects — msg.params is not mutated
    return createNotification(msg.method, {
      ...params,
      textDocument: { ...td, version: td['version'] + offset },
    });
  }

  /** Get documents with effective versions (client version + offset) for replay. */
  private getDocumentsWithEffectiveVersions(): readonly import('./types.js').TrackedDocument[] {
    return docs.toArray(this.documents).map((doc) => {
      const offset = this.versionOffsets.get(doc.uri) ?? 0;
      return offset > 0 ? { ...doc, version: doc.version + offset } : doc;
    });
  }

  /** Fan out textDocument/diagnostic to all matching servers and merge results. */
  private async handleDiagnosticPull(msg: RequestMessage): Promise<void> {
    const uri = extractUri(msg);
    const serverNames = this.router.serversForUri(uri);

    const requests = serverNames
      .map(name => this.servers.get(name))
      .filter(s => s !== undefined)
      .map(s => s.sendRequest('textDocument/diagnostic', msg.params));

    const responses = await Promise.all(requests);

    const allItems: unknown[] = [];
    for (const res of responses) {
      if (!res.result || !isPlainObject(res.result)) continue;
      const items = res.result['items'];
      if (Array.isArray(items)) {
        for (const item of items) allItems.push(item);
      }
    }

    this.respondToClient(msg.id, { kind: 'full', items: allItems });
  }

  /** Pull diagnostics from all matching servers and store results.
   *  Only publishes if at least one server returns items — avoids
   *  spurious re-publications that race with push-based servers. */
  private async pullDiagnostics(uri: string): Promise<void> {
    const serverNames = this.router.serversForUri(uri);
    const params = { textDocument: { uri } };

    const responses = await Promise.all(
      serverNames
        .map(name => this.servers.get(name))
        .filter(s => s !== undefined)
        .map(async (s) => {
          const res = await s.sendRequest('textDocument/diagnostic', params);
          return { name: s.name, res };
        }),
    );

    let updated = false;
    for (const { name, res } of responses) {
      if (!res.result || !isPlainObject(res.result)) continue;
      const items = res.result['items'];
      if (!Array.isArray(items)) continue;
      this.diagnosticsStore = diag.update(this.diagnosticsStore, name, uri, items);
      updated = true;
    }

    if (updated) {
      this.publishMergedDiagnostics(uri);
    }
  }

  // ── Logging ──────────────────────────────────────────────────────────

  /** Forward server window/logMessage at appropriate level; log others at DEBUG
   *  unless the server config declares a custom log level for the notification. */
  private logServerNotification(serverName: string, msg: NotificationMessage): void {
    if (msg.method === 'window/logMessage') {
      const parsed = v.safeParse(LogMessageSchema, msg.params);
      if (parsed.success) {
        this.log[parsed.output.type](`${serverName}:`, parsed.output.message);
      }
      return;
    }
    const notifConfig = this.serverConfigs.get(serverName)?.notifications?.[msg.method];
    if (notifConfig) {
      this.log[notifConfig.logLevel](`${serverName}:`, msg.method, JSON.stringify(msg.params));
      return;
    }
    this.log.debug(`${serverName} → proxy: notification ${msg.method}`);
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  /** Safe check that avoids TS narrowing issues across async boundaries. */
  private isStopped(): boolean { return this.state === 'stopped'; }

  private publishMergedDiagnostics(uri: string): void {
    const merged = diag.merge(this.diagnosticsStore, uri);
    this.log.debug(`Publishing ${String(merged.length)} merged diagnostics for ${uri}`);
    this.writeToClient(createNotification('textDocument/publishDiagnostics', {
      uri,
      diagnostics: merged,
    }));
  }

  private ackToServer(serverName: string, requestId: number | string | null): void {
    const response: ResponseMessage = { jsonrpc: '2.0', id: requestId, result: null };
    this.servers.get(serverName)?.send(response);
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
      this.log.warn('Client write failed:', err);
    });
  }

  dispose(): void {
    if (this.state === 'stopped') return;
    this.state = 'stopped';
    this.watcher?.dispose();
    this.watcher = null;
    for (const server of this.servers.values()) server.dispose();
    this.clientReader.dispose();
    this.log.info('Proxy shut down');
    this.resolveDone?.();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}
