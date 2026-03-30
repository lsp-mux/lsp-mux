import { readFile, stat } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { normalizeFileUri } from './uri.js';
import type { TrackedDocument } from './types.js';
import * as fw from './file-watcher.js';
import { createFlushScheduler } from './flush-scheduler.js';
import type { FlushScheduler } from './flush-scheduler.js';
import type { Logger } from './logger.js';

const WATCHER_DEBOUNCE_MS = 250;
const WATCHER_MAX_WAIT_MS = 2000;
const FLUSH_BATCH_SIZE = 100;
const DEFAULT_MAX_PENDING_EVENTS = 10_000;
const DEFAULT_MAX_RESYNC_BYTES = 1024 * 1024; // 1 MB

const isNodeError = (err: unknown): err is NodeJS.ErrnoException =>
  err instanceof Error && 'code' in err;

const isEnoent = (err: unknown): boolean =>
  isNodeError(err) && err.code === 'ENOENT';

export interface WatcherDelegate {
  isStopped(): boolean;
  getDocument(uri: string): TrackedDocument | undefined;
  matchEvent(relativePath: string, changeType: number, uri: string): ReadonlyMap<string, fw.FileChange[]>;
  /** Update tracked content, bump version offset, and fan out didChange to matching servers. */
  resyncDocument(uri: string, clientVersion: number, text: string): void;
  sendWatchedFilesEvent(serverName: string, changes: fw.FileChange[]): void;
}

export interface WorkspaceWatcherOptions {
  log: Logger;
  workspaceRoot: string;
  watcherExclude?: readonly string[] | undefined;
  maxResyncBytes?: number | undefined;
  maxPendingEvents?: number | undefined;
}

export class WorkspaceWatcher {
  private readonly workspaceRoot: string;
  private resolvedRoot: string | null = null;
  private watcher: FSWatcher | null = null;
  private scheduler: FlushScheduler | null = null;
  private readonly pendingEvents = new Set<string>();
  private pendingOverflowWarned = false;
  private _isDegraded = false;
  private readonly isExcluded: (path: string) => boolean;
  private readonly maxResyncBytes: number;
  private readonly maxPendingEvents: number;
  private readonly delegate: WatcherDelegate;
  private readonly log: Logger;

  get isDegraded(): boolean { return this._isDegraded; }

  constructor(options: WorkspaceWatcherOptions, delegate: WatcherDelegate) {
    this.workspaceRoot = options.workspaceRoot;
    this.isExcluded = fw.createExcludeMatcher(options.watcherExclude ?? []);
    this.maxResyncBytes = options.maxResyncBytes ?? DEFAULT_MAX_RESYNC_BYTES;
    this.maxPendingEvents = options.maxPendingEvents ?? DEFAULT_MAX_PENDING_EVENTS;
    this.delegate = delegate;
    this.log = options.log;
  }

  async start(): Promise<void> {
    this.resolvedRoot = await fw.resolveRoot(this.workspaceRoot);

    if (process.platform === 'linux') {
      const major = Number(process.versions.node.split('.')[0]);
      if (major < 20) {
        this.log.warn(`Recursive file watching may not work on Linux with Node.js ${process.versions.node} (requires ≥20.x)`);
      }
    }

    const root = this.workspaceRoot;
    const pending = this.pendingEvents;

    this.scheduler = createFlushScheduler({
      debounceMs: WATCHER_DEBOUNCE_MS,
      maxWaitMs: WATCHER_MAX_WAIT_MS,
      onFlush: () => this.flushFileEvents(),
    });

    this.watcher = watch(
      root,
      { recursive: true },
      (_event, filename) => {
        if (!filename) return;
        if (this.delegate.isStopped()) return;

        const normalized = filename.replace(/\\/g, '/');
        if (this.isExcluded(normalized)) return;

        if (pending.size >= this.maxPendingEvents && !pending.has(normalized)) {
          if (!this.pendingOverflowWarned) {
            this.log.warn(`Pending file events exceeded cap (${String(this.maxPendingEvents)}) — dropping new events until flush`);
            this.pendingOverflowWarned = true;
          }
          return;
        }

        pending.add(normalized);
        this.scheduler?.notify();
      },
    );

    this.watcher.on('error', (err) => {
      this.log.error('Workspace watcher error — file watching may be degraded:', err);
      this._isDegraded = true;
    });

    this.log.info(`Watching workspace: ${this.workspaceRoot}`);
  }

  private async flushFileEvents(): Promise<void> {
    if (!this.resolvedRoot) return;
    const root = this.workspaceRoot;
    const resolvedRoot = this.resolvedRoot;

    const events = new Set(this.pendingEvents);
    this.pendingEvents.clear();
    this.pendingOverflowWarned = false;

    const batched = new Map<string, fw.FileChange[]>();

    let count = 0;
    for (const relativePath of events) {
      if (this.delegate.isStopped()) break;

      try {
        const fullPath = join(root, relativePath);

        if (!await fw.isWithinRoot(fullPath, resolvedRoot)) {
          this.log.warn(`Skipping event outside workspace root: ${relativePath}`);
          continue;
        }

        const fileUri = normalizeFileUri(pathToFileURL(fullPath).href);
        const isTracked = this.delegate.getDocument(fileUri) !== undefined;

        let fileExists: boolean;
        try {
          await stat(fullPath);
          fileExists = true;
        }
        catch (err) {
          // Only ENOENT means truly deleted; permission/symlink errors → treat as existing
          fileExists = !isEnoent(err);
        }
        let changeType = fw.classifyChange(fileExists);

        if (changeType !== fw.FileChangeType.Deleted && isTracked) {
          const result = await this.resyncTrackedFile(fileUri);
          if (result === 'deleted') changeType = fw.FileChangeType.Deleted;
        }

        const matches = this.delegate.matchEvent(relativePath, changeType, fileUri);
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
        this.log.error(`Error processing file event for ${relativePath}:`, err);
      }

      count++;
      if (count % FLUSH_BATCH_SIZE === 0) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
      }
    }

    for (const [serverName, changes] of batched) {
      this.delegate.sendWatchedFilesEvent(serverName, changes);
    }
  }

  private async resyncTrackedFile(uri: string): Promise<'resynced' | 'unchanged' | 'deleted'> {
    const tracked = this.delegate.getDocument(uri);
    if (!tracked) return 'unchanged';

    const filePath = fileURLToPath(uri);

    // Stat pre-filter: 2x threshold so near-boundary files still get the
    // exact byteLength check after readFile (UTF-8 multi-byte expansion).
    try {
      const fileStat = await stat(filePath);
      if (fileStat.size > this.maxResyncBytes * 2) {
        this.log.warn(`Skipping resync for ${uri} (${String(fileStat.size)} bytes exceeds limit)`);
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
      this.log.warn(`Skipping resync for ${uri} (${String(byteLength)} bytes exceeds ${String(this.maxResyncBytes)} limit)`);
      return 'unchanged';
    }

    if (text === tracked.content) return 'unchanged';

    const current = this.delegate.getDocument(uri);
    if (current?.version !== tracked.version) {
      this.log.info(`Skipping resync for ${uri} — document modified by client during read`);
      return 'unchanged';
    }

    this.delegate.resyncDocument(uri, tracked.version, text);

    this.log.info(`Resynced ${uri} from disk`);
    return 'resynced';
  }

  dispose(): void {
    this.scheduler?.dispose();
    this.scheduler = null;
    this.watcher?.close();
    this.watcher = null;
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}
