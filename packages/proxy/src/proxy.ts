import { readFile, stat } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node.js';
import type { Message, NotificationMessage, RequestMessage, ResponseMessage, ServerConfig } from './types.js';
import * as v from 'valibot';
import { Message as Msg, createNotification, DOCUMENT_SYNC_METHODS, LSP_ERROR_CODES } from './types.js';
import { createManagedServer } from './managed-server.js';
import type { ManagedServer, ServerState } from './managed-server.js';
import { createRouter, extractUri } from './router.js';
import type { Router } from './router.js';
import { isPlainObject, STATIC_CAPABILITIES } from './capabilities.js';
import * as diag from './diagnostics-store.js';
import * as docs from './document-tracker.js';
import * as fw from './file-watcher.js';
import { createFlushScheduler } from './flush-scheduler.js';
import type { FlushScheduler } from './flush-scheduler.js';
import type { RestartPolicy } from './restart-scheduler.js';
import { log } from './logger.js';

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

const WATCHER_DEBOUNCE_MS = 250;
const WATCHER_MAX_WAIT_MS = 2000;
const FLUSH_BATCH_SIZE = 100;
const DEFAULT_MAX_PENDING_EVENTS = 10_000;
const DEFAULT_MAX_RESYNC_BYTES = 1024 * 1024; // 1 MB

const isNodeError = (err: unknown): err is NodeJS.ErrnoException =>
  err instanceof Error && 'code' in err;

const isEnoent = (err: unknown): boolean =>
  isNodeError(err) && err.code === 'ENOENT';

/** Ensures child servers see capabilities the proxy handles (e.g., file watching). */
const injectProxyCapabilities = (params: unknown): object => {
  const base = isPlainObject(params) ? params : {};
  const caps = isPlainObject(base['capabilities']) ? base['capabilities'] : {};
  const workspace = isPlainObject(caps['workspace']) ? caps['workspace'] : {};
  const dcwf = isPlainObject(workspace['didChangeWatchedFiles'])
    ? workspace['didChangeWatchedFiles']
    : {};

  return {
    ...base,
    capabilities: {
      ...caps,
      workspace: {
        ...workspace,
        didChangeWatchedFiles: { ...dcwf, dynamicRegistration: true },
      },
    },
  };
};

type ProxyState = 'idle' | 'running' | 'stopped';

export interface ProxyOptions {
  input?: NodeJS.ReadableStream;
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

  private state: ProxyState = 'idle';
  private documents: docs.DocumentMap = docs.empty();
  private diagnosticsStore: diag.DiagnosticsStore = diag.empty();
  private watchRegistrations: fw.WatchRegistrations = fw.empty();
  private initParams: RequestMessage['params'];
  private workspaceRoot: string | null = null;
  private resolvedRoot: string | null = null;
  private workspaceWatcher: FSWatcher | null = null;
  private flushScheduler: FlushScheduler | null = null;
  private readonly isExcluded: (path: string) => boolean;
  private readonly maxResyncBytes: number;
  private readonly maxPendingEvents: number;
  private pendingOverflowWarned = false;

  /** True when the workspace watcher encountered a fatal error (e.g., ENOSPC).
   *  File watching may be partially or fully non-functional. */
  get isWatcherDegraded(): boolean { return this._watcherDegraded; }
  private _watcherDegraded = false;
  private readonly servers: Map<string, ManagedServer>;
  private readonly router: Router;

  // Track which server owns each pending client request (used for cancel routing)
  private readonly requestRouting = new Map<number | string | null, string>();

  // Track which server originated each server-to-client request (for response routing)
  private readonly serverRequestRouting = new Map<number | string | null, string>();

  // Per-document version offset: added to client versions before forwarding to servers.
  // Bumped on resync so server versions stay monotonically increasing.
  private readonly versionOffsets = new Map<string, number>();

  // Shared pending-event set written by the watcher callback, drained by flushFileEvents
  private readonly pendingEvents = new Set<string>();

  private resolveDone?: () => void;

  constructor(serverConfigs: ReadonlyMap<string, ServerConfig>, options?: ProxyOptions) {
    this.clientReader = new StreamMessageReader(options?.input ?? process.stdin);
    this.clientWriter = new StreamMessageWriter(options?.output ?? process.stdout);
    this.isExcluded = fw.createExcludeMatcher(options?.watcherExclude ?? []);
    this.maxResyncBytes = options?.maxResyncBytes ?? DEFAULT_MAX_RESYNC_BYTES;
    this.maxPendingEvents = options?.maxPendingEvents ?? DEFAULT_MAX_PENDING_EVENTS;

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
    // Servers check this to decide whether to use dynamic registration.
    const serverInitParams = injectProxyCapabilities(this.initParams);

    // Store init params on each server for lazy start — no spawning yet.
    for (const server of this.servers.values()) {
      server.setInitParams(serverInitParams);
    }

    this.respondToClient(clientRequestId, { capabilities: STATIC_CAPABILITIES });
    this.state = 'running';
    await this.startWorkspaceWatcher();
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
      log.info('LSP handshake complete');
      return;
    }

    if (Msg.isNotification(msg) && DOCUMENT_SYNC_METHODS.has(msg.method)) {
      const uri = extractUri(msg);

      // Reset version offset on open/close — client version is authoritative
      if (msg.method === 'textDocument/didOpen' || msg.method === 'textDocument/didClose') {
        if (uri) this.versionOffsets.delete(uri);
      }

      const rewritten = this.rewriteDocSyncVersion(msg, uri);
      for (const name of this.router.serversForUri(uri)) {
        this.servers.get(name)?.send(rewritten);
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
    if (Msg.isNotification(msg) && msg.method === 'textDocument/publishDiagnostics') {
      const result = v.safeParse(PublishDiagnosticsSchema, msg.params);
      if (result.success) {
        this.diagnosticsStore = diag.update(this.diagnosticsStore, serverName, result.output.uri, result.output.diagnostics);
        this.publishMergedDiagnostics(result.output.uri);
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
      if (reg.method === 'workspace/didChangeWatchedFiles') {
        const opts = v.safeParse(fw.RegisterOptionsSchema, reg.registerOptions);
        if (opts.success) {
          this.watchRegistrations = fw.register(
            this.watchRegistrations, serverName, reg.id, opts.output,
            this.workspaceRoot ?? undefined,
          );
          handledCount++;
          log.info(`${serverName}: registered file watcher ${reg.id}`);
          continue;
        }
        // Malformed watcher registration — log and count as handled (don't forward)
        log.warn(`${serverName}: malformed watcher registration ${reg.id} — skipping`);
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
      if (unreg.method === 'workspace/didChangeWatchedFiles') {
        this.watchRegistrations = fw.unregister(this.watchRegistrations, unreg.id);
        handledCount++;
        log.info(`${serverName}: unregistered file watcher ${unreg.id}`);
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

  private handlePendingErrors(_serverName: string, ids: ReadonlySet<number | string | null>, message: string): void {
    for (const id of ids) {
      this.sendErrorToClient(id, LSP_ERROR_CODES.InternalError, message);
      this.requestRouting.delete(id);
    }
  }

  private handleServerStateChange(serverName: string, serverState: ServerState): void {
    if (serverState === 'restarting' || serverState === 'starting') {
      const { store, affectedUris } = diag.clearServer(this.diagnosticsStore, serverName);
      this.diagnosticsStore = store;
      for (const uri of affectedUris) this.publishMergedDiagnostics(uri);

      this.watchRegistrations = fw.unregisterServer(this.watchRegistrations, serverName);
    }

    const allStopped = [...this.servers.values()].every(s => s.state === 'stopped');
    if (allStopped && this.state === 'running') {
      log.error('All servers stopped — proxy stopping');
      this.dispose();
    }
  }

  // ── File Watching ─────────────────────────────────────────────────────

  private async startWorkspaceWatcher(): Promise<void> {
    const parsed = v.safeParse(InitializeParamsSchema, this.initParams);
    const rootUri = parsed.success ? parsed.output.rootUri : undefined;
    if (!rootUri) return;

    try {
      this.workspaceRoot = fileURLToPath(rootUri);
    }
    catch {
      return;
    }

    const exists = await stat(this.workspaceRoot).then(() => true, () => false);
    if (!exists) return;

    this.resolvedRoot = await fw.resolveRoot(this.workspaceRoot);

    if (process.platform === 'linux') {
      const major = Number(process.versions.node.split('.')[0]);
      if (major < 20) {
        log.warn(`Recursive file watching may not work on Linux with Node.js ${process.versions.node} (requires ≥20.x)`);
      }
    }

    const root = this.workspaceRoot;

    // The watcher callback (synchronous, runs on the event loop between awaits)
    // writes into pendingEvents. flushFileEvents snapshots and clears it at the
    // start of each flush. Events arriving *during* an async flush land in the
    // fresh map and are processed by the scheduler's re-check mechanism
    // (notifiedDuringFlush → setTimeout(0) → next doFlush call). This avoids
    // both double-processing and lost events without explicit locking.
    const pending = this.pendingEvents;

    this.flushScheduler = createFlushScheduler({
      debounceMs: WATCHER_DEBOUNCE_MS,
      maxWaitMs: WATCHER_MAX_WAIT_MS,
      onFlush: () => this.flushFileEvents(),
    });

    this.workspaceWatcher = watch(
      root,
      { recursive: true },
      (_event, filename) => {
        if (!filename) return;
        if (this.state === 'stopped') return;

        const normalized = filename.replace(/\\/g, '/');
        if (this.isExcluded(normalized)) return;

        // Backpressure: drop new paths when the pending map exceeds the cap.
        // Dropped events may re-fire from the watcher on the next cycle.
        if (pending.size >= this.maxPendingEvents && !pending.has(normalized)) {
          if (!this.pendingOverflowWarned) {
            log.warn(`Pending file events exceeded cap (${String(this.maxPendingEvents)}) — dropping new events until flush`);
            this.pendingOverflowWarned = true;
          }
          return;
        }

        pending.add(normalized);

        this.flushScheduler?.notify();
      },
    );

    this.workspaceWatcher.on('error', (err) => {
      log.error('Workspace watcher error — file watching may be degraded:', err);
      this._watcherDegraded = true;
    });

    log.info(`Watching workspace: ${this.workspaceRoot}`);
  }

  private async flushFileEvents(): Promise<void> {
    if (!this.workspaceRoot || !this.resolvedRoot) return;
    const root = this.workspaceRoot;
    const resolvedRoot = this.resolvedRoot;

    // Snapshot-and-clear: events arriving during async processing go into a
    // fresh pendingEvents map and are picked up by the scheduler's re-check
    // (via notifiedDuringFlush), not by a loop here.
    const events = new Set(this.pendingEvents);
    this.pendingEvents.clear();
    this.pendingOverflowWarned = false;

    // Accumulate all file changes per server for batched dispatch
    const batched = new Map<string, fw.FileChange[]>();

    // Events are processed serially. Concurrent processing (Promise.all with a
    // pool) would reduce wall time for large batches but risks saturating disk
    // I/O and complicates error handling for per-file resync.
    let count = 0;
    for (const relativePath of events) {
      if (this.isStopped()) break;

      try {
        const fullPath = join(root, relativePath);

        // Skip events that resolve outside the workspace root (e.g., via .. or symlinks)
        if (!await fw.isWithinRoot(fullPath, resolvedRoot)) {
          log.warn(`Skipping event outside workspace root: ${relativePath}`);
          continue;
        }

        const fileUri = pathToFileURL(fullPath).href;
        const isTracked = this.documents.has(fileUri);

        // NOTE: stat here, isWithinRoot above, and resyncTrackedFile below each
        // touch the filesystem independently. Combining them would reduce syscalls
        // but would leak resync concerns into path validation (or vice versa).
        const fileExists = await stat(fullPath).then(() => true, () => false);
        let changeType = fw.classifyChange(fileExists);

        // Resync tracked (open) documents
        if (changeType !== fw.FileChangeType.Deleted && isTracked) {
          const result = await this.resyncTrackedFile(fileUri);
          // TOCTOU: file vanished between stat and readFile
          if (result === 'deleted') changeType = fw.FileChangeType.Deleted;
        }

        // Accumulate matched events per server (batched dispatch below)
        const matches = fw.matchEvent(this.watchRegistrations, relativePath, changeType, fileUri);
        for (const [serverName, changes] of matches) {
          const existing = batched.get(serverName);
          if (existing) {
            existing.push(...changes);
          }
          else {
            batched.set(serverName, [...changes]);
          }
        }
      }
      catch (err) {
        // Per-file errors must not abort the entire batch — log and continue
        log.error(`Error processing file event for ${relativePath}:`, err);
      }

      // Yield to event loop periodically to avoid blocking during large batches
      count++;
      if (count % FLUSH_BATCH_SIZE === 0) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
      }
    }

    // Dispatch one batched notification per server
    for (const [serverName, changes] of batched) {
      this.servers.get(serverName)?.send(
        createNotification('workspace/didChangeWatchedFiles', { changes }),
      );
    }
  }

  private async resyncTrackedFile(uri: string): Promise<'resynced' | 'unchanged' | 'deleted'> {
    const tracked = this.documents.get(uri);
    if (!tracked) return 'unchanged';

    const filePath = fileURLToPath(uri);

    // Stat pre-filter: skip clearly oversized files without reading them.
    // Uses 2x threshold so near-boundary files still get the exact check below.
    try {
      const fileStat = await stat(filePath);
      if (fileStat.size > this.maxResyncBytes * 2) {
        log.warn(`Skipping resync for ${uri} (${String(fileStat.size)} bytes exceeds limit)`);
        return 'unchanged';
      }
    }
    catch (err) {
      return isEnoent(err) ? 'deleted' : 'unchanged';
    }

    let text: string;
    try {
      text = await readFile(filePath, 'utf-8');
    }
    catch (err) {
      return isEnoent(err) ? 'deleted' : 'unchanged';
    }

    const byteLength = Buffer.byteLength(text);
    if (byteLength > this.maxResyncBytes) {
      log.warn(`Skipping resync for ${uri} (${String(byteLength)} bytes exceeds ${String(this.maxResyncBytes)} limit)`);
      return 'unchanged';
    }

    if (text === tracked.content) return 'unchanged';

    // Optimistic concurrency: a client didChange may have arrived during the
    // await above. If the document version changed, the client edit takes
    // precedence — skip the resync to avoid overwriting it.
    const current = this.documents.get(uri);
    if (current?.version !== tracked.version) {
      log.info(`Skipping resync for ${uri} — document modified by client during read`);
      return 'unchanged';
    }

    // Bump version offset so server versions stay monotonically increasing
    const offset = (this.versionOffsets.get(uri) ?? 0) + 1;
    this.versionOffsets.set(uri, offset);
    const serverVersion = tracked.version + offset;

    // Update tracked content (client version stays unchanged)
    this.documents = docs.trackChange(this.documents, {
      textDocument: { uri, version: tracked.version },
      contentChanges: [{ text }],
    });

    // Send didChange with full content (avoids diagnostics flicker from close/reopen)
    const changeNotification = createNotification('textDocument/didChange', {
      textDocument: { uri, version: serverVersion },
      contentChanges: [{ text }],
    });
    for (const name of this.router.serversForUri(uri)) {
      this.servers.get(name)?.send(changeNotification);
    }

    log.info(`Resynced ${uri} from disk (v${String(serverVersion)})`);
    return 'resynced';
  }

  // ── Version Rewriting ─────────────────────────────────────────────────

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

  // ── Helpers ───────────────────────────────────────────────────────────

  /** Safe check that avoids TS narrowing issues across async boundaries. */
  private isStopped(): boolean { return this.state === 'stopped'; }

  private publishMergedDiagnostics(uri: string): void {
    const merged = diag.merge(this.diagnosticsStore, uri);
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
      log.warn('Client write failed:', err);
    });
  }

  dispose(): void {
    if (this.state === 'stopped') return;
    this.state = 'stopped';
    this.flushScheduler?.dispose();
    this.flushScheduler = null;
    this.workspaceWatcher?.close();
    this.workspaceWatcher = null;
    for (const server of this.servers.values()) server.dispose();
    this.clientReader.dispose();
    log.info('Proxy shut down');
    this.resolveDone?.();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}
