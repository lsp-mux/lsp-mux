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
describe.sequential('WorkspaceWatcher resyncTrackedFile', () => {
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
    const doc = makeDoc('vanished.ts', faker.lorem.sentence());
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
    const doc = makeDoc('perm.ts', faker.lorem.sentence());
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
    const doc = makeDoc('gone.ts', faker.lorem.sentence());
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
    const doc = makeDoc('huge.ts', faker.lorem.sentence());
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
    const doc = makeDoc('big.ts', faker.lorem.sentence());
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
    const v1 = makeDoc('race.ts', oldContent);
    const v2 = makeDoc('race.ts', clientContent, 2);
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
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining('modified by client') as unknown,
    );
  });
});
