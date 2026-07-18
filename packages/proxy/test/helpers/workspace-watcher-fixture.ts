import { watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { faker } from '@faker-js/faker';
import { vi } from 'vitest';
import { type MockProxy, mock } from 'vitest-mock-extended';
import * as fw from '../../src/file-watcher.ts';
import { createFlushScheduler } from '../../src/flush-scheduler.ts';
import type { FlushScheduler } from '../../src/flush-scheduler.ts';
import { createLogger } from '../../src/logger.ts';
import type { Logger } from '../../src/logger.ts';
import { normalizeFileUri } from '../../src/uri.ts';
import { WorkspaceWatcher } from '../../src/workspace-watcher.ts';
import type { WatcherDelegate, WorkspaceWatcherOptions } from '../../src/workspace-watcher.ts';

/*
 * Shared fixture for the WorkspaceWatcher test modules. These helpers drive
 * the module-level mocks for node:fs, node:fs/promises, flush-scheduler,
 * file-watcher, and logger — but vi.mock is hoisted per test module and
 * cannot live here, so each consuming test file MUST register those
 * vi.mock(...) declarations itself.
 */

export const WORKSPACE = path.join(import.meta.dirname, '..', 'fake-workspace');

export const toUri = (relativePath: string) =>
  normalizeFileUri(pathToFileURL(path.join(WORKSPACE, relativePath)).href);

/** Build a tracked-document fixture for the given workspace-relative file. */
export const makeDoc = (name: string, content: string, version = 1) => ({
  uri: toUri(name),
  languageId: 'typescript',
  version,
  content,
});

export const createDelegate = (): MockProxy<WatcherDelegate> => {
  const delegate = mock<WatcherDelegate>();
  // Sensible defaults; individual tests override via mockReturnValue.
  delegate.isStopped.mockReturnValue(false);
  delegate.matchEvent.mockReturnValue(new Map());
  return delegate;
};

export const nodeError = (code: string): NodeJS.ErrnoException => {
  const err = new Error(`${code} error`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
};

export interface Fixture {
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
export const createFixture = (): Fixture => {
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
