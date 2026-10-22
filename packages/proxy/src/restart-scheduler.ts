import { defaultTimers } from './types.ts';
import type { Timers } from './types.ts';

export interface RestartPolicy {
  readonly maxRetries: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /**
   * How long a server has to stay up to earn back one spent attempt.
   */
  readonly stabilityWindowMs: number;
}

export const defaultRestartPolicy: RestartPolicy = {
  maxRetries: 5,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
  stabilityWindowMs: 10_000,
};

// Exponential backoff base and the ±ratio of random jitter applied to it.
const backoffMultiplier = 2;
const jitterRatio = 0.5;

export interface RestartScheduler {
  /**
   * Schedule a callback with exponential backoff. Returns false if max retries reached.
   */
  schedule: (callback: () => void) => boolean;
  /**
   * Note that a server came up. It earns back one spent attempt per stability
   * window it survives, so a server that answers its handshake and then dies
   * keeps spending its budget and a crash loop still reaches the cap.
   */
  markStarted: () => void;
  /**
   * Cancel any pending timer.
   */
  cancel: () => void;
  readonly attempt: number;
  readonly maxRetries: number;
}

export interface RestartSchedulerOptions {
  policy: RestartPolicy;
  timers?: Timers | undefined;
}

export const createRestartScheduler = (
  { policy, timers = defaultTimers }: RestartSchedulerOptions,
): RestartScheduler => {
  let count = 0;
  let retryTimer: unknown;
  let refundTimer: unknown;

  const clear = (timer: unknown): void => {
    if (timer !== undefined) {
      timers.clearTimeout(timer);
    }
  };

  /*
   * One attempt per window rather than the whole budget: a server that flaps,
   * holds on for a window, then flaps again would otherwise start every bout
   * with a full budget and never reach the cap. Keeps running while anything
   * is still owed, so a long healthy run does earn the budget back in full.
   */
  const refund = (): void => {
    count = Math.max(0, count - 1);
    refundTimer = count > 0
      ? timers.setTimeout(refund, policy.stabilityWindowMs)
      : undefined;
  };

  return {
    schedule(callback) {
      /* This crash proves the run being refunded was not stable after all,
         and a budget already spent stays spent. */
      clear(refundTimer);
      refundTimer = undefined;

      if (count >= policy.maxRetries) return false;

      const base = Math.min(policy.baseDelayMs * backoffMultiplier ** count, policy.maxDelayMs);
      // Add ±50% jitter to prevent thundering herd when multiple servers crash,
      // clamped so jittered delay never exceeds the configured max.
      const jitter = Math.min(base * (jitterRatio + Math.random()), policy.maxDelayMs);
      count++;
      retryTimer = timers.setTimeout(callback, jitter);
      return true;
    },

    markStarted() {
      clear(refundTimer);
      refundTimer = timers.setTimeout(refund, policy.stabilityWindowMs);
    },

    cancel() {
      clear(retryTimer);
      retryTimer = undefined;
      clear(refundTimer);
      refundTimer = undefined;
    },

    get attempt() {
      return count;
    },

    get maxRetries() {
      return policy.maxRetries;
    },
  };
};
