/*
 * The two waits a child's teardown is built from, each bounded so no single
 * server can hold it open: one for the `exit` reaching the pipe, one for the
 * process acting on it. Both are mechanism only — what the budgets are belongs
 * with the process they govern, in `child-server.ts`.
 */

/**
 * What a bounded exit wait needs of a child process: whether it has already
 * gone, and notice when it does.
 */
export interface ExitReporter {
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  once: (event: 'exit', listener: () => void) => void;
}

/**
 * Resolve when the promise settles or when the budget runs out, whichever
 * comes first. Settling either way counts, failure included: a caller waiting
 * out a write wants the stream done with it, not successful, and a teardown
 * wait that threw would strand whatever it was clearing up.
 */
export const settleWithin = async (promise: Promise<void>, budgetMs: number): Promise<void> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, budgetMs);
      }),
    ]);
  } catch {
    // Settled is settled.
  }
  clearTimeout(timer);
};

/**
 * Resolve when the process exits or when the budget runs out, whichever comes
 * first.
 */
export const waitForExit = (proc: ExitReporter, budgetMs: number): Promise<void> =>
  new Promise((resolve) => {
    /*
     * Already gone, and its exit event fired before there was a listener here
     * to catch it: a child that dies while the write is still flushing would
     * otherwise be waited out in full, for an event that has been and gone.
     */
    if (proc.exitCode !== null || proc.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      resolve();
    }, budgetMs);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
