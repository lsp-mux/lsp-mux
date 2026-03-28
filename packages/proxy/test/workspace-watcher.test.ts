import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:fs/promises', () => ({
  stat: vi.fn(),
  readFile: vi.fn(),
}));
vi.mock('node:fs', () => ({
  watch: vi.fn(),
}));
vi.mock('../src/flush-scheduler.js', () => ({
  createFlushScheduler: vi.fn(),
}));
vi.mock('../src/file-watcher.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/file-watcher.js')>();
  return {
    ...actual,
    resolveRoot: vi.fn(),
    isWithinRoot: vi.fn(),
  };
});
vi.mock('../src/logger.js', () => ({
  createLogger: vi.fn(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
}));

import { stat, readFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import * as fw from '../src/file-watcher.js';
import { createFlushScheduler } from '../src/flush-scheduler.js';
import { createLogger } from '../src/logger.js';
import type { Logger } from '../src/logger.js';
import { WorkspaceWatcher, type WatcherDelegate, type WorkspaceWatcherOptions } from '../src/workspace-watcher.js';

const WORKSPACE = join(import.meta.dirname, 'fake-workspace');

const toUri = (relativePath: string) =>
  pathToFileURL(join(WORKSPACE, relativePath)).href;

const createDelegate = (overrides?: Partial<WatcherDelegate>): WatcherDelegate => ({
  isStopped: vi.fn(() => false),
  getDocument: vi.fn(() => undefined),
  matchEvent: vi.fn(() => new Map()),
  resyncDocument: vi.fn(),
  sendWatchedFilesEvent: vi.fn(),
  ...overrides,
});

const nodeError = (code: string): NodeJS.ErrnoException => {
  const err = new Error(`${code} error`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
};

let log: Logger;
let onFlush: () => Promise<void>;
let watchCallback: (event: string, filename: string | null) => void;
let mockFsWatcher: { on: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };

beforeEach(() => {
  log = vi.mocked(createLogger)();
  mockFsWatcher = { on: vi.fn(), close: vi.fn() };

  vi.mocked(fw.resolveRoot).mockResolvedValue(WORKSPACE);
  vi.mocked(fw.isWithinRoot).mockResolvedValue(true);
  vi.mocked(stat).mockResolvedValue({ size: 100 } as ReturnType<typeof stat> extends Promise<infer T> ? T : never);
  vi.mocked(readFile).mockResolvedValue('file content');

  vi.mocked(watch).mockImplementation((...args: unknown[]) => {
    watchCallback = args[2] as typeof watchCallback;
    return mockFsWatcher as unknown as FSWatcher;
  });
  vi.mocked(createFlushScheduler).mockImplementation((opts) => {
    onFlush = opts.onFlush;
    return { notify: vi.fn(), dispose: vi.fn() };
  });
});

const startWatcher = async (delegate: WatcherDelegate, opts?: Omit<Partial<WorkspaceWatcherOptions>, 'log'>) => {
  const watcher = new WorkspaceWatcher({ log, workspaceRoot: WORKSPACE, ...opts }, delegate);
  await watcher.start();
  return watcher;
};

const addEvent = (filename: string) => {
  watchCallback('change', filename);
};

// Sequential: tests share module-level vi.mock state
describe.sequential('WorkspaceWatcher', () => {
  describe('flushFileEvents', () => {
    it('dispatches matched events via delegate', async () => {
      const changes: fw.FileChange[] = [{ uri: toUri('test.ts'), type: fw.FileChangeType.Changed }];
      const delegate = createDelegate({
        matchEvent: vi.fn(() => new Map([['mock', changes]])),
      });

      await startWatcher(delegate);
      addEvent('test.ts');
      await onFlush();

      expect(delegate.matchEvent).toHaveBeenCalledWith(
        'test.ts', fw.FileChangeType.Changed, toUri('test.ts'),
      );
      expect(delegate.sendWatchedFilesEvent).toHaveBeenCalledWith('mock', changes);
    });

    it('classifies ENOENT stat error as Deleted', async () => {
      vi.mocked(stat).mockRejectedValue(nodeError('ENOENT'));
      const delegate = createDelegate();

      await startWatcher(delegate);
      addEvent('gone.ts');
      await onFlush();

      expect(delegate.matchEvent).toHaveBeenCalledWith(
        'gone.ts', fw.FileChangeType.Deleted, expect.stringContaining('gone.ts') as unknown,
      );
    });

    it('classifies non-ENOENT stat error as Changed', async () => {
      vi.mocked(stat).mockRejectedValue(nodeError('EACCES'));
      const delegate = createDelegate();

      await startWatcher(delegate);
      addEvent('denied.ts');
      await onFlush();

      expect(delegate.matchEvent).toHaveBeenCalledWith(
        'denied.ts', fw.FileChangeType.Changed, expect.stringContaining('denied.ts') as unknown,
      );
    });

    it('skips events outside workspace root', async () => {
      vi.mocked(fw.isWithinRoot).mockResolvedValue(false);
      const delegate = createDelegate();

      await startWatcher(delegate);
      addEvent('../escape.ts');
      await onFlush();

      expect(delegate.matchEvent).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('outside workspace root') as unknown);
    });

    it('stops processing when isStopped returns true', async () => {
      const delegate = createDelegate({
        isStopped: vi.fn(() => true),
      });

      await startWatcher(delegate);
      addEvent('a.ts');
      addEvent('b.ts');
      await onFlush();

      expect(delegate.matchEvent).not.toHaveBeenCalled();
    });

    it('resyncs tracked files on change', async () => {
      const doc = { uri: toUri('tracked.ts'), languageId: 'typescript', version: 1, content: 'old' };
      vi.mocked(readFile).mockResolvedValue('new content');

      const delegate = createDelegate({
        getDocument: vi.fn(() => doc),
        matchEvent: vi.fn(() => new Map()),
      });

      await startWatcher(delegate);
      addEvent('tracked.ts');
      await onFlush();

      expect(delegate.resyncDocument).toHaveBeenCalledWith(toUri('tracked.ts'), 1, 'new content');
    });

    it('handles per-file errors without aborting batch', async () => {
      vi.mocked(fw.isWithinRoot)
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce(true);

      const changes: fw.FileChange[] = [{ uri: toUri('b.ts'), type: fw.FileChangeType.Changed }];
      const delegate = createDelegate({
        matchEvent: vi.fn(() => new Map([['mock', changes]])),
      });

      await startWatcher(delegate);
      addEvent('a.ts');
      addEvent('b.ts');
      await onFlush();

      expect(log.error).toHaveBeenCalledWith(expect.stringContaining('a.ts') as unknown, expect.anything());
      expect(delegate.sendWatchedFilesEvent).toHaveBeenCalledWith('mock', changes);
    });

    it('normalizes backslashes in filenames', async () => {
      const delegate = createDelegate();

      await startWatcher(delegate);
      watchCallback('change', 'sub\\file.ts');
      await onFlush();

      expect(delegate.matchEvent).toHaveBeenCalledWith(
        'sub/file.ts', expect.any(Number) as unknown, expect.anything(),
      );
    });
  });

  describe('resyncTrackedFile', () => {
    it('returns unchanged when content matches disk', async () => {
      const doc = { uri: toUri('same.ts'), languageId: 'typescript', version: 1, content: 'same' };
      vi.mocked(readFile).mockResolvedValue('same');
      const delegate = createDelegate({ getDocument: vi.fn(() => doc) });

      await startWatcher(delegate);
      addEvent('same.ts');
      await onFlush();

      expect(delegate.resyncDocument).not.toHaveBeenCalled();
    });

    it('returns unchanged when document not tracked', async () => {
      const delegate = createDelegate({ getDocument: vi.fn(() => undefined) });

      await startWatcher(delegate);
      addEvent('untracked.ts');
      await onFlush();

      expect(delegate.resyncDocument).not.toHaveBeenCalled();
    });

    it('returns deleted on stat ENOENT', async () => {
      const doc = { uri: toUri('vanished.ts'), languageId: 'typescript', version: 1, content: 'old' };
      // First stat (flush existence check) succeeds, second stat (resync) fails
      vi.mocked(stat)
        .mockResolvedValueOnce({ size: 10 } as Awaited<ReturnType<typeof stat>>)
        .mockRejectedValueOnce(nodeError('ENOENT'));
      const delegate = createDelegate({ getDocument: vi.fn(() => doc) });

      await startWatcher(delegate);
      addEvent('vanished.ts');
      await onFlush();

      expect(delegate.resyncDocument).not.toHaveBeenCalled();
      // File classified as Deleted after resync returned 'deleted'
      expect(delegate.matchEvent).toHaveBeenCalledWith(
        'vanished.ts', fw.FileChangeType.Deleted, expect.anything(),
      );
    });

    it('returns unchanged on stat non-ENOENT error', async () => {
      const doc = { uri: toUri('perm.ts'), languageId: 'typescript', version: 1, content: 'old' };
      vi.mocked(stat)
        .mockResolvedValueOnce({ size: 10 } as Awaited<ReturnType<typeof stat>>)
        .mockRejectedValueOnce(nodeError('EACCES'));
      const delegate = createDelegate({ getDocument: vi.fn(() => doc) });

      await startWatcher(delegate);
      addEvent('perm.ts');
      await onFlush();

      expect(delegate.resyncDocument).not.toHaveBeenCalled();
      // Still classified as Changed (not Deleted)
      expect(delegate.matchEvent).toHaveBeenCalledWith(
        'perm.ts', fw.FileChangeType.Changed, expect.anything(),
      );
    });

    it('returns deleted on readFile ENOENT', async () => {
      const doc = { uri: toUri('gone.ts'), languageId: 'typescript', version: 1, content: 'old' };
      vi.mocked(readFile).mockRejectedValue(nodeError('ENOENT'));
      const delegate = createDelegate({ getDocument: vi.fn(() => doc) });

      await startWatcher(delegate);
      addEvent('gone.ts');
      await onFlush();

      expect(delegate.resyncDocument).not.toHaveBeenCalled();
      expect(delegate.matchEvent).toHaveBeenCalledWith(
        'gone.ts', fw.FileChangeType.Deleted, expect.anything(),
      );
    });

    it('skips files exceeding stat 2x pre-filter', async () => {
      const doc = { uri: toUri('huge.ts'), languageId: 'typescript', version: 1, content: 'old' };
      vi.mocked(stat).mockResolvedValue({ size: 300 } as Awaited<ReturnType<typeof stat>>);
      const delegate = createDelegate({ getDocument: vi.fn(() => doc) });

      await startWatcher(delegate, { maxResyncBytes: 100 });
      addEvent('huge.ts');
      await onFlush();

      expect(delegate.resyncDocument).not.toHaveBeenCalled();
      expect(readFile).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('exceeds limit') as unknown);
    });

    it('skips files exceeding byteLength threshold', async () => {
      const doc = { uri: toUri('big.ts'), languageId: 'typescript', version: 1, content: 'old' };
      // stat.size passes 2x filter (150 < 200) but byteLength (150) > maxResyncBytes (100)
      vi.mocked(stat).mockResolvedValue({ size: 150 } as Awaited<ReturnType<typeof stat>>);
      vi.mocked(readFile).mockResolvedValue('x'.repeat(150));
      const delegate = createDelegate({ getDocument: vi.fn(() => doc) });

      await startWatcher(delegate, { maxResyncBytes: 100 });
      addEvent('big.ts');
      await onFlush();

      expect(delegate.resyncDocument).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('exceeds') as unknown);
    });

    it('skips when version changed during read (optimistic concurrency)', async () => {
      const v1 = { uri: toUri('race.ts'), languageId: 'typescript', version: 1, content: 'old' };
      const v2 = { uri: toUri('race.ts'), languageId: 'typescript', version: 2, content: 'client edit' };
      vi.mocked(readFile).mockResolvedValue('disk content');

      // Call order: flush isTracked → resync initial → resync re-check
      const getDocument = vi.fn()
        .mockReturnValueOnce(v1) // flush: isTracked check
        .mockReturnValueOnce(v1) // resync: initial read
        .mockReturnValueOnce(v2); // resync: concurrency re-check (version changed)

      const delegate = createDelegate({ getDocument });

      await startWatcher(delegate);
      addEvent('race.ts');
      await onFlush();

      expect(delegate.resyncDocument).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining('modified by client') as unknown);
    });
  });

  describe('backpressure', () => {
    it('drops events exceeding maxPendingEvents and warns once', async () => {
      const delegate = createDelegate();

      await startWatcher(delegate, { maxPendingEvents: 2 });
      addEvent('a.ts');
      addEvent('b.ts');
      addEvent('c.ts'); // dropped
      addEvent('d.ts'); // dropped
      await onFlush();

      // Only a.ts and b.ts should have been processed
      expect(delegate.matchEvent).toHaveBeenCalledTimes(2);
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('exceeded cap') as unknown);
    });

    it('allows duplicate paths within the cap', async () => {
      const delegate = createDelegate();

      await startWatcher(delegate, { maxPendingEvents: 1 });
      addEvent('a.ts');
      addEvent('a.ts'); // same path — allowed (Set deduplication, not counted as new)
      await onFlush();

      expect(delegate.matchEvent).toHaveBeenCalledTimes(1);
      expect(log.warn).not.toHaveBeenCalled();
    });
  });

  describe('lifecycle', () => {
    it('dispose cleans up scheduler and watcher', async () => {
      const delegate = createDelegate();
      const watcher = await startWatcher(delegate);

      watcher.dispose();

      const scheduler = vi.mocked(createFlushScheduler).mock.results[0]?.value as { dispose: ReturnType<typeof vi.fn> };
      expect(scheduler.dispose).toHaveBeenCalled();
      expect(mockFsWatcher.close).toHaveBeenCalled();
    });

    it('Symbol.dispose calls dispose', async () => {
      const delegate = createDelegate();
      const watcher = await startWatcher(delegate);

      watcher[Symbol.dispose]();

      expect(mockFsWatcher.close).toHaveBeenCalled();
    });

    it('isDegraded is false initially', async () => {
      const delegate = createDelegate();
      const watcher = await startWatcher(delegate);

      expect(watcher.isDegraded).toBe(false);
    });
  });
});
