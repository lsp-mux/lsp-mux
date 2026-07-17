import { watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { faker } from '@faker-js/faker';
import { describe, it, vi } from 'vitest';
import { type MockProxy, mock } from 'vitest-mock-extended';
import * as fw from '../src/file-watcher.ts';
import { createFlushScheduler } from '../src/flush-scheduler.ts';
import type { FlushScheduler } from '../src/flush-scheduler.ts';
import { createLogger } from '../src/logger.ts';
import type { Logger } from '../src/logger.ts';
import { normalizeFileUri } from '../src/uri.ts';
import { type WatcherDelegate, WorkspaceWatcher, type WorkspaceWatcherOptions } from '../src/workspace-watcher.ts';

/* eslint-disable-next-line vitest/prefer-import-in-mock --
   Node's overloaded fs signatures aren't reproduced by vi.fn<typeof fn>(),
   so the typed import() form rejects the partial factory (Partial<T> shape
   mismatch on the overloaded member). Keep the string form. */
vi.mock('node:fs/promises', () => ({
  stat: vi.fn<typeof stat>(),
  readFile: vi.fn<typeof readFile>(),
}));
/* eslint-disable-next-line vitest/prefer-import-in-mock --
   Node's overloaded fs.watch signature isn't reproduced by vi.fn<typeof
   watch>(), so the typed import() form rejects the partial factory. Keep the
   string form. */
vi.mock('node:fs', () => ({
  watch: vi.fn<typeof watch>(),
}));
vi.mock(import('../src/flush-scheduler.ts'), () => ({
  createFlushScheduler: vi.fn<typeof createFlushScheduler>(),
}));
vi.mock(import('../src/file-watcher.ts'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    resolveRoot: vi.fn<typeof fw.resolveRoot>(),
    isWithinRoot: vi.fn<typeof fw.isWithinRoot>(),
  };
});
vi.mock(import('../src/logger.ts'), () => ({
  createLogger: vi.fn<typeof createLogger>(),
}));

const WORKSPACE = path.join(import.meta.dirname, 'fake-workspace');

const toUri = (relativePath: string) =>
  normalizeFileUri(pathToFileURL(path.join(WORKSPACE, relativePath)).href);

const createDelegate = (): MockProxy<WatcherDelegate> => {
  const delegate = mock<WatcherDelegate>();
  // Sensible defaults; individual tests override via mockReturnValue.
  delegate.isStopped.mockReturnValue(false);
  delegate.matchEvent.mockReturnValue(new Map());
  return delegate;
};

const nodeError = (code: string): NodeJS.ErrnoException => {
  const err = new Error(`${code} error`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
};

interface Fixture {
  log: MockProxy<Logger>;
  mockFsWatcher: MockProxy<FSWatcher>;
  startWatcher: (
    delegate: WatcherDelegate,
    opts?: Omit<Partial<WorkspaceWatcherOptions>, 'log'>,
  ) => Promise<WorkspaceWatcher>;
  addEvent: (filename: string) => void;
  onFlush: () => Promise<void>;
}

/*
 * Per-test fixture: wires the module-level fs/watcher/scheduler mocks and
 * exposes the lazily-captured watch callback and flush trigger. Instantiate
 * at the start of each test so no mock state leaks between cases.
 */
const createFixture = (): Fixture => {
  const log = mock<Logger>();
  const mockFsWatcher = mock<FSWatcher>();
  const captured: {
    watchCallback?: (event: string, filename: string | null) => void;
    onFlush?: () => Promise<void>;
  } = {};

  vi.mocked(createLogger).mockReturnValue(log);
  vi.mocked(fw.resolveRoot).mockResolvedValue(WORKSPACE);
  vi.mocked(fw.isWithinRoot).mockResolvedValue(true);
  vi.mocked(stat).mockResolvedValue({ size: 100 } as Awaited<ReturnType<typeof stat>>);
  vi.mocked(readFile).mockResolvedValue(faker.lorem.sentence());
  vi.mocked(watch).mockImplementation((...args: unknown[]) => {
    captured.watchCallback = args[2] as NonNullable<typeof captured.watchCallback>;
    return mockFsWatcher;
  });
  vi.mocked(createFlushScheduler).mockImplementation((opts) => {
    captured.onFlush = opts.onFlush;
    return mock<FlushScheduler>();
  });

  const startWatcher = async (
    delegate: WatcherDelegate,
    opts?: Omit<Partial<WorkspaceWatcherOptions>, 'log'>,
  ): Promise<WorkspaceWatcher> => {
    const watcher = new WorkspaceWatcher({ log, workspaceRoot: WORKSPACE, ...opts }, delegate);
    await watcher.start();
    return watcher;
  };
  const addEvent = (filename: string): void => {
    if (!captured.watchCallback) throw new Error('watch not started; call startWatcher first');
    captured.watchCallback('change', filename);
  };
  const onFlush = (): Promise<void> => {
    if (!captured.onFlush) throw new Error('scheduler not started; call startWatcher first');
    return captured.onFlush();
  };

  return { log, mockFsWatcher, startWatcher, addEvent, onFlush };
};

// Sequential: the module-level vi.mock'd fs/watcher are shared; each test
// re-wires them via createFixture().
describe.sequential('WorkspaceWatcher', () => {
  describe('flushFileEvents', () => {
    it('dispatches matched events via delegate', async ({ expect }) => {
      const { startWatcher, addEvent, onFlush } = createFixture();
      const changes: fw.FileChange[] = [{ uri: toUri('test.ts'), type: fw.FileChangeType.Changed }];
      const delegate = createDelegate();
      delegate.matchEvent.mockReturnValue(new Map([['mock', changes]]));

      await startWatcher(delegate);
      addEvent('test.ts');
      await onFlush();

      expect(delegate.matchEvent).toHaveBeenCalledWith(
        'test.ts', fw.FileChangeType.Changed, toUri('test.ts'),
      );
      expect(delegate.sendWatchedFilesEvent).toHaveBeenCalledWith('mock', changes);
    });

    it('classifies ENOENT stat error as Deleted', async ({ expect }) => {
      const { startWatcher, addEvent, onFlush } = createFixture();
      vi.mocked(stat).mockRejectedValue(nodeError('ENOENT'));
      const delegate = createDelegate();

      await startWatcher(delegate);
      addEvent('gone.ts');
      await onFlush();

      expect(delegate.matchEvent).toHaveBeenCalledWith(
        'gone.ts', fw.FileChangeType.Deleted, expect.stringContaining('gone.ts') as unknown,
      );
    });

    it('classifies non-ENOENT stat error as Changed', async ({ expect }) => {
      const { startWatcher, addEvent, onFlush } = createFixture();
      vi.mocked(stat).mockRejectedValue(nodeError('EACCES'));
      const delegate = createDelegate();

      await startWatcher(delegate);
      addEvent('denied.ts');
      await onFlush();

      expect(delegate.matchEvent).toHaveBeenCalledWith(
        'denied.ts', fw.FileChangeType.Changed, expect.stringContaining('denied.ts') as unknown,
      );
    });

    it('skips events outside workspace root', async ({ expect }) => {
      const { startWatcher, addEvent, onFlush, log } = createFixture();
      vi.mocked(fw.isWithinRoot).mockResolvedValue(false);
      const delegate = createDelegate();

      await startWatcher(delegate);
      addEvent('../escape.ts');
      await onFlush();

      expect(delegate.matchEvent).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('outside workspace root') as unknown);
    });

    it('stops processing when isStopped returns true', async ({ expect }) => {
      const { startWatcher, addEvent, onFlush } = createFixture();
      const delegate = createDelegate();
      delegate.isStopped.mockReturnValue(true);

      await startWatcher(delegate);
      addEvent('a.ts');
      addEvent('b.ts');
      await onFlush();

      expect(delegate.matchEvent).not.toHaveBeenCalled();
    });

    it('resyncs tracked files on change', async ({ expect }) => {
      const { startWatcher, addEvent, onFlush } = createFixture();
      const oldContent = faker.lorem.sentence();
      const newContent = faker.lorem.sentence();
      const doc = { uri: toUri('tracked.ts'), languageId: 'typescript', version: 1, content: oldContent };
      vi.mocked(readFile).mockResolvedValue(newContent);

      const delegate = createDelegate();
      delegate.getDocument.mockReturnValue(doc);

      await startWatcher(delegate);
      addEvent('tracked.ts');
      await onFlush();

      expect(delegate.resyncDocument).toHaveBeenCalledWith(toUri('tracked.ts'), 1, newContent);
    });

    it('handles per-file errors without aborting batch', async ({ expect }) => {
      const { startWatcher, addEvent, onFlush, log } = createFixture();
      vi.mocked(fw.isWithinRoot)
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce(true);

      const changes: fw.FileChange[] = [{ uri: toUri('b.ts'), type: fw.FileChangeType.Changed }];
      const delegate = createDelegate();
      delegate.matchEvent.mockReturnValue(new Map([['mock', changes]]));

      await startWatcher(delegate);
      addEvent('a.ts');
      addEvent('b.ts');
      await onFlush();

      expect(log.error).toHaveBeenCalledWith(expect.stringContaining('a.ts') as unknown, expect.anything());
      expect(delegate.sendWatchedFilesEvent).toHaveBeenCalledWith('mock', changes);
    });

    it('normalizes backslashes in filenames', async ({ expect }) => {
      const { startWatcher, addEvent, onFlush } = createFixture();
      const delegate = createDelegate();

      await startWatcher(delegate);
      addEvent(String.raw`sub\file.ts`);
      await onFlush();

      expect(delegate.matchEvent).toHaveBeenCalledWith(
        'sub/file.ts', expect.any(Number) as unknown, expect.anything(),
      );
    });
  });

  describe('resyncTrackedFile', () => {
    it('returns unchanged when content matches disk', async ({ expect }) => {
      const { startWatcher, addEvent, onFlush } = createFixture();
      const content = faker.lorem.sentence();
      const doc = { uri: toUri('same.ts'), languageId: 'typescript', version: 1, content };
      vi.mocked(readFile).mockResolvedValue(content);
      const delegate = createDelegate();
      delegate.getDocument.mockReturnValue(doc);

      await startWatcher(delegate);
      addEvent('same.ts');
      await onFlush();

      expect(delegate.resyncDocument).not.toHaveBeenCalled();
    });

    it('returns unchanged when document not tracked', async ({ expect }) => {
      const { startWatcher, addEvent, onFlush } = createFixture();
      const delegate = createDelegate();
      delegate.getDocument.mockReturnValue(undefined);

      await startWatcher(delegate);
      addEvent('untracked.ts');
      await onFlush();

      expect(delegate.resyncDocument).not.toHaveBeenCalled();
    });

    it('returns deleted on stat ENOENT', async ({ expect }) => {
      const { startWatcher, addEvent, onFlush } = createFixture();
      const doc = { uri: toUri('vanished.ts'), languageId: 'typescript', version: 1, content: faker.lorem.sentence() };
      // First stat (flush existence check) succeeds, second stat (resync) fails
      vi.mocked(stat)
        .mockResolvedValueOnce({ size: 10 } as Awaited<ReturnType<typeof stat>>)
        .mockRejectedValueOnce(nodeError('ENOENT'));
      const delegate = createDelegate();
      delegate.getDocument.mockReturnValue(doc);

      await startWatcher(delegate);
      addEvent('vanished.ts');
      await onFlush();

      expect(delegate.resyncDocument).not.toHaveBeenCalled();
      // File classified as Deleted after resync returned 'deleted'
      expect(delegate.matchEvent).toHaveBeenCalledWith(
        'vanished.ts', fw.FileChangeType.Deleted, expect.anything(),
      );
    });

    it('returns unchanged on stat non-ENOENT error', async ({ expect }) => {
      const { startWatcher, addEvent, onFlush } = createFixture();
      const doc = { uri: toUri('perm.ts'), languageId: 'typescript', version: 1, content: faker.lorem.sentence() };
      vi.mocked(stat)
        .mockResolvedValueOnce({ size: 10 } as Awaited<ReturnType<typeof stat>>)
        .mockRejectedValueOnce(nodeError('EACCES'));
      const delegate = createDelegate();
      delegate.getDocument.mockReturnValue(doc);

      await startWatcher(delegate);
      addEvent('perm.ts');
      await onFlush();

      expect(delegate.resyncDocument).not.toHaveBeenCalled();
      // Still classified as Changed (not Deleted)
      expect(delegate.matchEvent).toHaveBeenCalledWith(
        'perm.ts', fw.FileChangeType.Changed, expect.anything(),
      );
    });

    it('returns deleted on readFile ENOENT', async ({ expect }) => {
      const { startWatcher, addEvent, onFlush } = createFixture();
      const doc = { uri: toUri('gone.ts'), languageId: 'typescript', version: 1, content: faker.lorem.sentence() };
      vi.mocked(readFile).mockRejectedValue(nodeError('ENOENT'));
      const delegate = createDelegate();
      delegate.getDocument.mockReturnValue(doc);

      await startWatcher(delegate);
      addEvent('gone.ts');
      await onFlush();

      expect(delegate.resyncDocument).not.toHaveBeenCalled();
      expect(delegate.matchEvent).toHaveBeenCalledWith(
        'gone.ts', fw.FileChangeType.Deleted, expect.anything(),
      );
    });

    it('skips files exceeding stat 2x pre-filter', async ({ expect }) => {
      const { startWatcher, addEvent, onFlush, log } = createFixture();
      const doc = { uri: toUri('huge.ts'), languageId: 'typescript', version: 1, content: faker.lorem.sentence() };
      vi.mocked(stat).mockResolvedValue({ size: 300 } as Awaited<ReturnType<typeof stat>>);
      const delegate = createDelegate();
      delegate.getDocument.mockReturnValue(doc);

      await startWatcher(delegate, { maxResyncBytes: 100 });
      addEvent('huge.ts');
      await onFlush();

      expect(delegate.resyncDocument).not.toHaveBeenCalled();
      expect(readFile).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('exceeds limit') as unknown);
    });

    it('skips files exceeding byteLength threshold', async ({ expect }) => {
      const { startWatcher, addEvent, onFlush, log } = createFixture();
      const doc = { uri: toUri('big.ts'), languageId: 'typescript', version: 1, content: faker.lorem.sentence() };
      // stat.size passes 2x filter (150 < 200) but byteLength (150) > maxResyncBytes (100)
      vi.mocked(stat).mockResolvedValue({ size: 150 } as Awaited<ReturnType<typeof stat>>);
      vi.mocked(readFile).mockResolvedValue('x'.repeat(150));
      const delegate = createDelegate();
      delegate.getDocument.mockReturnValue(doc);

      await startWatcher(delegate, { maxResyncBytes: 100 });
      addEvent('big.ts');
      await onFlush();

      expect(delegate.resyncDocument).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('exceeds') as unknown);
    });

    it('skips when version changed during read (optimistic concurrency)', async ({ expect }) => {
      const { startWatcher, addEvent, onFlush, log } = createFixture();
      const oldContent = faker.lorem.sentence();
      const clientContent = faker.lorem.sentence();
      const diskContent = faker.lorem.sentence();
      const v1 = { uri: toUri('race.ts'), languageId: 'typescript', version: 1, content: oldContent };
      const v2 = { uri: toUri('race.ts'), languageId: 'typescript', version: 2, content: clientContent };
      vi.mocked(readFile).mockResolvedValue(diskContent);

      const delegate = createDelegate();
      // Call order: flush isTracked → resync initial → resync re-check
      delegate.getDocument
        .mockReturnValueOnce(v1) // flush: isTracked check
        .mockReturnValueOnce(v1) // resync: initial read
        .mockReturnValueOnce(v2); // resync: concurrency re-check (version changed)

      await startWatcher(delegate);
      addEvent('race.ts');
      await onFlush();

      expect(delegate.resyncDocument).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining('modified by client') as unknown);
    });
  });

  describe('backpressure', () => {
    it('drops events exceeding maxPendingEvents and warns once', async ({ expect }) => {
      const { startWatcher, addEvent, onFlush, log } = createFixture();
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

    it('allows duplicate paths within the cap', async ({ expect }) => {
      const { startWatcher, addEvent, onFlush, log } = createFixture();
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
    it('dispose cleans up scheduler and watcher', async ({ expect }) => {
      const { startWatcher, mockFsWatcher } = createFixture();
      const delegate = createDelegate();
      const watcher = await startWatcher(delegate);

      watcher.dispose();

      const scheduler = vi.mocked(createFlushScheduler).mock.results[0]?.value as { dispose: ReturnType<typeof vi.fn> };

      expect(scheduler.dispose).toHaveBeenCalled();
      expect(mockFsWatcher.close).toHaveBeenCalled();
    });

    it('symbol.dispose calls dispose', async ({ expect }) => {
      const { startWatcher, mockFsWatcher } = createFixture();
      const delegate = createDelegate();
      const watcher = await startWatcher(delegate);

      watcher[Symbol.dispose]();

      expect(mockFsWatcher.close).toHaveBeenCalled();
    });

    it('isDegraded is false initially', async ({ expect }) => {
      const { startWatcher } = createFixture();
      const delegate = createDelegate();
      const watcher = await startWatcher(delegate);

      expect(watcher.isDegraded).toBe(false);
    });
  });
});
