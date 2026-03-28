import { defaultTimers } from './types.js';
import type { Timers } from './types.js';

export interface RestartPolicy {
  readonly maxRetries: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export const DEFAULT_RESTART_POLICY: RestartPolicy = {
  maxRetries: 5,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
};

export interface RestartScheduler {
  /** Schedule a callback with exponential backoff. Returns false if max retries reached. */
  schedule(callback: () => void): boolean;
  /** Reset attempt counter (call after successful restart). */
  reset(): void;
  /** Cancel any pending timer. */
  cancel(): void;
  readonly attempt: number;
  readonly maxRetries: number;
}

export interface RestartSchedulerOptions {
  policy: RestartPolicy;
  timers?: Timers | undefined;
}

export const createRestartScheduler = ({ policy, timers: t = defaultTimers }: RestartSchedulerOptions): RestartScheduler => {
  let count = 0;
  let timer: unknown = null;

  return {
    schedule(callback) {
      if (count >= policy.maxRetries) return false;
      const base = Math.min(policy.baseDelayMs * 2 ** count, policy.maxDelayMs);
      // Add ±50% jitter to prevent thundering herd when multiple servers crash,
      // clamped so jittered delay never exceeds the configured max.
      const jitter = Math.min(base * (0.5 + Math.random()), policy.maxDelayMs);
      count++;
      timer = t.setTimeout(callback, jitter);
      return true;
    },

    reset() {
      count = 0;
    },

    cancel() {
      if (timer) {
        t.clearTimeout(timer);
        timer = null;
      }
    },

    get attempt() {
      return count;
    },

    get maxRetries() {
      return policy.maxRetries;
    },
  };
};
