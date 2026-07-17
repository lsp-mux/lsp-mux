import { type FSWatcher, watch } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as fw from './file-watcher.ts';
import { createFlushScheduler } from './flush-scheduler.ts';
import type { FlushScheduler } from './flush-scheduler.ts';
import type { Logger } from './logger.ts';
import type { TrackedDocument } from './types.ts';
import { normalizeFileUri } from './uri.ts';

const bytesPerKibibyte = 1024;
// Node added recursive fs.watch on Linux in 20.x.
const minRecursiveWatchNodeMajor = 20;
// A UTF-8 file can expand by at most this factor when decoded, so oversize
// files are cheaply rejected before reading.
const maxResyncByteExpansionFactor = 2;

const watcherDebounceMs = 250;
const watcherMaxWaitMs = 2000;
const flushBatchSize = 100;
const defaultMaxPendingEvents = 10_000;
const defaultMaxResyncBytes = bytesPerKibibyte * bytesPerKibibyte; // 1 MB

const isNodeError = (err: unknown): err is NodeJS.ErrnoException =>
  err instanceof Error && 'code' in err;

const isEnoent = (err: unknown): boolean =>
  isNodeError(err) && err.code === 'ENOENT';

export interface WatcherDelegate {
  isStopped: () => boolean;
  getDocument: (uri: string) => TrackedDocument | undefined;
  matchEvent: (
    relativePath: string,
    changeType: number,
    uri: string,
  ) => ReadonlyMap<string, fw.FileChange[]>;
  /** Update tracked content, bump version offset, and fan out didChange to matching servers. */
  resyncDocument: (uri: string, clientVersion: number, text: string) => void;
  sendWatchedFilesEvent: (serverName: string, changes: fw.FileChange[]) => void;
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
  private resolvedRoot: string | undefined;
  private watcher: FSWatcher | undefined;
  private scheduler: FlushScheduler | undefined;
  private readonly pendingEvents = new Set<string>();
  private pendingOverflowWarned = false;
  private _isDegraded = false;
  private readonly isExcluded: (path: string) => boolean;
  private readonly maxResyncBytes: number;
  private readonly maxPendingEvents: number;
  private readonly delegate: WatcherDelegate;
  private readonly log: Logger;

  constructor(options: WorkspaceWatcherOptions, delegate: WatcherDelegate) {
    this.workspaceRoot = options.workspaceRoot;
    this.isExcluded = fw.createExcludeMatcher(options.watcherExclude ?? []);
    this.maxResyncBytes = options.maxResyncBytes ?? defaultMaxResyncBytes;
    this.maxPendingEvents = options.maxPendingEvents ?? defaultMaxPendingEvents;
    this.delegate = delegate;
    this.log = options.log;
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
        const matches = await this.classifyEvent(relativePath, root, resolvedRoot);
        for (const [serverName, changes] of matches) {
          const existing = batched.get(serverName);
          if (existing) {
            existing.push(...changes);
          } else {
            batched.set(serverName, [...changes]);
          }
        }
      } catch (error) {
        this.log.error(`Error processing file event for ${relativePath}:`, error);
      }

      count++;
      if (count % flushBatchSize === 0) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
      }
    }

    for (const [serverName, changes] of batched) {
      this.delegate.sendWatchedFilesEvent(serverName, changes);
    }
  }

  private async classifyEvent(
    relativePath: string,
    root: string,
    resolvedRoot: string,
  ): Promise<ReadonlyMap<string, fw.FileChange[]>> {
    const fullPath = path.join(root, relativePath);

    if (!await fw.isWithinRoot(fullPath, resolvedRoot)) {
      this.log.warn(`Skipping event outside workspace root: ${relativePath}`);
      return new Map();
    }

    const fileUri = normalizeFileUri(pathToFileURL(fullPath).href);
    const isTracked = this.delegate.getDocument(fileUri) !== undefined;

    let isFileExists: boolean;
    try {
      await stat(fullPath);
      isFileExists = true;
    } catch (error) {
      // Only ENOENT means truly deleted; permission/symlink errors → treat as existing
      isFileExists = !isEnoent(error);
    }
    let changeType = fw.classifyChange(isFileExists);

    if (changeType !== fw.FileChangeType.Deleted && isTracked) {
      const result = await this.resyncTrackedFile(fileUri);
      if (result === 'deleted') changeType = fw.FileChangeType.Deleted;
    }

    return this.delegate.matchEvent(relativePath, changeType, fileUri);
  }

  private async readForResync(
    uri: string,
    filePath: string,
  ): Promise<'unchanged' | 'deleted' | { text: string }> {
    // Stat pre-filter: 2x threshold so near-boundary files still get the
    // exact byteLength check after readFile (UTF-8 multi-byte expansion).
    try {
      const fileStat = await stat(filePath);
      if (fileStat.size > this.maxResyncBytes * maxResyncByteExpansionFactor) {
        this.log.warn(`Skipping resync for ${uri} (${String(fileStat.size)} bytes exceeds limit)`);
        return 'unchanged';
      }
    } catch (error) {
      return isEnoent(error) ? 'deleted' : 'unchanged';
    }

    let text: string;
    try {
      text = await readFile(filePath, 'utf8');
    } catch (error) {
      return isEnoent(error) ? 'deleted' : 'unchanged';
    }

    const byteLength = Buffer.byteLength(text);
    if (byteLength > this.maxResyncBytes) {
      this.log.warn(
        `Skipping resync for ${uri} ` +
        `(${String(byteLength)} bytes exceeds ${String(this.maxResyncBytes)} limit)`,
      );
      return 'unchanged';
    }

    return { text };
  }

  private async resyncTrackedFile(uri: string): Promise<'resynced' | 'unchanged' | 'deleted'> {
    const tracked = this.delegate.getDocument(uri);
    if (!tracked) return 'unchanged';

    const filePath = fileURLToPath(uri);
    const read = await this.readForResync(uri, filePath);
    if (read === 'unchanged' || read === 'deleted') return read;

    if (read.text === tracked.content) return 'unchanged';

    const current = this.delegate.getDocument(uri);
    if (current?.version !== tracked.version) {
      this.log.info(`Skipping resync for ${uri} — document modified by client during read`);
      return 'unchanged';
    }

    this.delegate.resyncDocument(uri, tracked.version, read.text);

    this.log.info(`Resynced ${uri} from disk`);
    return 'resynced';
  }

  get isDegraded(): boolean { return this._isDegraded; }

  async start(): Promise<void> {
    this.resolvedRoot = await fw.resolveRoot(this.workspaceRoot);

    if (process.platform === 'linux') {
      const major = Number(process.versions.node.split('.', 1)[0]);
      if (major < minRecursiveWatchNodeMajor) {
        this.log.warn(
          'Recursive file watching may not work on Linux with Node.js ' +
          `${process.versions.node} (requires ≥20.x)`,
        );
      }
    }

    const root = this.workspaceRoot;
    const pending = this.pendingEvents;

    this.scheduler = createFlushScheduler({
      debounceMs: watcherDebounceMs,
      maxWaitMs: watcherMaxWaitMs,
      onFlush: () => this.flushFileEvents(),
    });

    this.watcher = watch(
      root,
      { recursive: true },
      (_event, filename) => {
        if (!filename) return;
        if (this.delegate.isStopped()) return;

        const normalized = filename.replaceAll('\\', '/');
        if (this.isExcluded(normalized)) return;

        if (pending.size >= this.maxPendingEvents && !pending.has(normalized)) {
          if (!this.pendingOverflowWarned) {
            this.log.warn(
              `Pending file events exceeded cap (${String(this.maxPendingEvents)}) — ` +
              'dropping new events until flush',
            );
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

  dispose(): void {
    this.scheduler?.dispose();
    this.scheduler = undefined;
    this.watcher?.close();
    this.watcher = undefined;
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}
