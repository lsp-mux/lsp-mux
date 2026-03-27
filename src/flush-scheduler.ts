import { noop } from './types.js';

export interface FlushSchedulerOptions {
  /** Delay before flushing after the last notification. */
  debounceMs: number;
  /** Maximum time to wait before forcing a flush, regardless of debounce resets. */
  maxWaitMs: number;
  /** Called when it's time to flush. Must not be called concurrently. */
  onFlush: () => Promise<void>;
}

export interface FlushScheduler {
  /** Signal that new data is available for flushing. */
  notify(): void;
  /** Cancel all pending timers and prevent future flushes. */
  dispose(): void;
}

/** State mutated asynchronously by notify/dispose during an in-flight flush.
 *  Stored in an object so TypeScript doesn't narrow away the mutations
 *  that occur across `await` boundaries. */
interface AsyncState {
  flushInProgress: boolean;
  notifiedDuringFlush: boolean;
  disposed: boolean;
}

export const createFlushScheduler = (options: FlushSchedulerOptions): FlushScheduler => {
  const { debounceMs, maxWaitMs, onFlush } = options;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
  const s: AsyncState = { flushInProgress: false, notifiedDuringFlush: false, disposed: false };

  const clearTimers = (): void => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (maxWaitTimer) {
      clearTimeout(maxWaitTimer);
      maxWaitTimer = null;
    }
  };

  // doFlush's finally block handles state reset; this catch prevents
  // unhandled promise rejection when onFlush throws.
  const triggerFlush = (): void => {
    doFlush().catch(noop);
  };

  const needsRecheck = (): boolean => s.notifiedDuringFlush && !s.disposed;

  const notify = (): void => {
    if (s.disposed) return;
    if (s.flushInProgress) {
      s.notifiedDuringFlush = true;
      return;
    }
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(triggerFlush, debounceMs);
    maxWaitTimer ??= setTimeout(triggerFlush, maxWaitMs);
  };

  const doFlush = async (): Promise<void> => {
    if (s.flushInProgress || s.disposed) return;
    // INVARIANT: clearTimers() resets both debounce and maxWait. This ensures
    // maxWait measures from the first notify() *after* the last flush, not from
    // the first notify() ever. If this line is removed or moved, maxWait could
    // fire during a subsequent flush cycle unexpectedly.
    clearTimers();
    s.flushInProgress = true;
    s.notifiedDuringFlush = false;
    try {
      await onFlush();
    }
    finally {
      s.flushInProgress = false;
      if (needsRecheck()) {
        // Re-enter the debounce cycle instead of flushing immediately.
        // This prevents I/O saturation under sustained load (continuous
        // file writes would otherwise cause back-to-back flushes with
        // zero delay).
        notify();
      }
    }
  };

  const dispose = (): void => {
    s.disposed = true;
    clearTimers();
  };

  return { notify, dispose };
};
