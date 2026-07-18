import { watch } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { faker } from '@faker-js/faker';
import { describe, it, vi } from 'vitest';
import * as fw from '../src/file-watcher.ts';
import { createFlushScheduler } from '../src/flush-scheduler.ts';
import { createLogger } from '../src/logger.ts';
import {
  createDelegate,
  createFixture,
  makeDoc,
  nodeError,
  toUri,
} from './helpers/workspace-watcher-fixture.ts';

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
      expect(log.warn).toHaveBeenCalledWith(
        expect.stringContaining('outside workspace root') as unknown,
      );
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
      const doc = makeDoc('tracked.ts', oldContent);
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

      expect(log.error).toHaveBeenCalledWith(
        expect.stringContaining('a.ts') as unknown,
        expect.anything(),
      );
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

      const scheduler = vi.mocked(createFlushScheduler).mock.results[0]?.value as {
        dispose: ReturnType<typeof vi.fn>;
      };

      expect(scheduler.dispose).toHaveBeenCalledWith();
      expect(mockFsWatcher.close).toHaveBeenCalledWith();
    });

    it('symbol.dispose calls dispose', async ({ expect }) => {
      const { startWatcher, mockFsWatcher } = createFixture();
      const delegate = createDelegate();
      const watcher = await startWatcher(delegate);

      watcher[Symbol.dispose]();

      expect(mockFsWatcher.close).toHaveBeenCalledWith();
    });

    it('isDegraded is false initially', async ({ expect }) => {
      const { startWatcher } = createFixture();
      const delegate = createDelegate();
      const watcher = await startWatcher(delegate);

      expect(watcher.isDegraded).toBe(false);
    });
  });
});
