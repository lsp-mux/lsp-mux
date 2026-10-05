import { describe, it } from 'vitest';
import { settleWithin, waitForExit } from '../src/bounded-wait.ts';
import type { ExitReporter } from '../src/bounded-wait.ts';

/**
 * Long enough that a wait which honours it rather than returning early fails
 * the test by outliving it, instead of passing slowly.
 */
const unreachableBudgetMs = 600_000;

/**
 * Short enough to spend inside a test, for the cases where running out of
 * budget is the behaviour under test.
 */
const spendableBudgetMs = 20;

interface FakeProcess extends ExitReporter {
  /**
   * Exit with a code and announce it, as a child acting on `exit` does.
   */
  readonly quit: (code: number) => void;
  /**
   * Exit by signal and announce it, as a killed child does.
   */
  readonly killed: (signal: NodeJS.Signals) => void;
  /**
   * Exit with nobody told, which is what a child dying before anything
   * listens for it looks like from here.
   */
  readonly quitUnannounced: (code: number) => void;
}

interface FakeProcessState {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  listener: (() => void) | undefined;
}

const fakeProcess = (): FakeProcess => {
  /* eslint-disable-next-line unicorn/no-null --
     Node reports a live process with both of these null, so a stub standing
     in for one has to start there. */
  const state: FakeProcessState = { exitCode: null, signalCode: null, listener: undefined };
  return {
    get exitCode() { return state.exitCode; },
    get signalCode() { return state.signalCode; },
    once: (_event, listener) => { state.listener = listener; },
    quit: (code) => {
      state.exitCode = code;
      state.listener?.();
    },
    killed: (signal) => {
      state.signalCode = signal;
      state.listener?.();
    },
    quitUnannounced: (code) => {
      state.exitCode = code;
    },
  };
};

/**
 * A promise nothing ever settles, standing in for a write to a child that has
 * stopped reading its stdin. `Promise.race` over nothing never settles.
 */
const neverSettles = (): Promise<void> => Promise.race([]);

describe(settleWithin, () => {
  it('returns once the promise settles', async ({ expect }) => {
    await expect(settleWithin(Promise.resolve(), unreachableBudgetMs)).resolves.toBeUndefined();
  });

  it('returns once the promise fails rather than passing the failure on', async ({ expect }) => {
    const failed = Promise.reject(new Error('stream destroyed'));

    await expect(settleWithin(failed, unreachableBudgetMs)).resolves.toBeUndefined();
  });

  it('returns on the budget when the promise never settles', async ({ expect }) => {
    await expect(settleWithin(neverSettles(), spendableBudgetMs)).resolves.toBeUndefined();
  });
});

describe(waitForExit, () => {
  it('returns when the process announces its exit', async ({ expect }) => {
    const proc = fakeProcess();
    const waited = waitForExit(proc, unreachableBudgetMs);

    proc.quit(0);

    await expect(waited).resolves.toBeUndefined();
  });

  it('returns when the process is killed', async ({ expect }) => {
    const proc = fakeProcess();
    const waited = waitForExit(proc, unreachableBudgetMs);

    proc.killed('SIGTERM');

    await expect(waited).resolves.toBeUndefined();
  });

  it('returns without waiting when the process has already exited', async ({ expect }) => {
    const proc = fakeProcess();
    proc.quitUnannounced(0);

    await expect(waitForExit(proc, unreachableBudgetMs)).resolves.toBeUndefined();
  });

  it('returns without waiting when the process has already been killed', async ({ expect }) => {
    const proc = fakeProcess();
    proc.killed('SIGKILL');

    await expect(waitForExit(proc, unreachableBudgetMs)).resolves.toBeUndefined();
  });

  it('returns on the budget when the process never exits', async ({ expect }) => {
    await expect(waitForExit(fakeProcess(), spendableBudgetMs)).resolves.toBeUndefined();
  });
});
