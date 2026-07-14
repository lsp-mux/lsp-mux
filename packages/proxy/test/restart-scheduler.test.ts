import { createClock } from '@sinonjs/fake-timers';
import { describe, it, vi } from 'vitest';
import { createRestartScheduler } from '../src/restart-scheduler.ts';
import type { Timers } from '../src/types.ts';

describe('RestartScheduler', () => {
  const policy = { maxRetries: 3, baseDelayMs: 100, maxDelayMs: 500 };

  it('schedules with exponential backoff', ({ expect }) => {
    const t = createClock();
    const sched = createRestartScheduler({ policy, timers: t });
    const calls: number[] = [];

    // Attempt 1: base 100 * 2^0 = 100ms, jittered to [50, 150]
    expect(sched.schedule(() => calls.push(1))).toBe(true);
    expect(sched.attempt).toBe(1);

    t.tick(150); // max jittered delay for base 100

    expect(calls).toEqual([1]);

    // Attempt 2: base 100 * 2^1 = 200ms, jittered to [100, 300]
    expect(sched.schedule(() => calls.push(2))).toBe(true);
    expect(sched.attempt).toBe(2);

    t.tick(300);

    expect(calls).toEqual([1, 2]);

    // Attempt 3: base min(400, 500) = 400ms, jittered to [200, 600)
    expect(sched.schedule(() => calls.push(3))).toBe(true);
    expect(sched.attempt).toBe(3);

    t.tick(600);

    expect(calls).toEqual([1, 2, 3]);

    // Attempt 4: over maxRetries
    expect(sched.schedule(() => calls.push(4))).toBe(false);
    expect(sched.attempt).toBe(3);
  });

  it('caps delay at maxDelayMs', ({ expect }) => {
    const t = createClock();
    const sched = createRestartScheduler({ policy: { maxRetries: 10, baseDelayMs: 100, maxDelayMs: 300 }, timers: t });
    const calls: number[] = [];

    // Attempt 1: base 100ms → jittered [50, 150]
    sched.schedule(() => calls.push(1));
    t.tick(150);

    // Attempt 2: base 200ms → jittered [100, 300]
    sched.schedule(() => calls.push(2));
    t.tick(300);

    // Attempt 3: base min(400, 300) = 300ms → jittered capped at 300
    sched.schedule(() => calls.push(3));

    expect(calls).toEqual([1, 2]);

    t.tick(450);

    expect(calls).toEqual([1, 2, 3]);
  });

  it('reset restores attempt counter', ({ expect }) => {
    const t = createClock();
    const sched = createRestartScheduler({ policy, timers: t });

    sched.schedule(() => { /* no-op */ });
    t.tick(150);
    sched.schedule(() => { /* no-op */ });
    t.tick(300);

    expect(sched.attempt).toBe(2);

    sched.reset();

    expect(sched.attempt).toBe(0);

    // Should schedule from attempt 1 again
    const called = vi.fn();

    expect(sched.schedule(called)).toBe(true);
    expect(sched.attempt).toBe(1);

    t.tick(150);

    expect(called).toHaveBeenCalledTimes(1);
  });

  it('cancel prevents pending callback', ({ expect }) => {
    const t = createClock();
    const sched = createRestartScheduler({ policy, timers: t });
    const called = vi.fn();

    sched.schedule(called);
    sched.cancel();
    t.tick(1000);

    expect(called).not.toHaveBeenCalled();
  });

  it('exposes maxRetries from policy', ({ expect }) => {
    const sched = createRestartScheduler({ policy });

    expect(sched.maxRetries).toBe(3);
  });

  it('adds jitter so simultaneous restarts do not thundering-herd', ({ expect }) => {
    const delays: number[] = [];
    const capturingTimers: Timers = {
      setTimeout: (_cb: () => void, ms: number) => {
        delays.push(ms);
        return delays.length;
      },
      clearTimeout: () => { /* no-op */ },
    };

    // Schedule 10 attempts to get enough samples to verify jitter variance
    const noop = (): void => { /* no-op */ };
    for (let i = 0; i < 10; i++) {
      const sched = createRestartScheduler({ policy, timers: capturingTimers });
      sched.schedule(noop);
    }

    // All use attempt 0 → deterministic base delay is 100ms.
    // With jitter, delays should be within [50, 150] (±50% of base)
    // and NOT all identical (which would indicate no jitter).
    expect(delays).toHaveLength(10);

    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(50);
      expect(d).toBeLessThanOrEqual(150);
    }
    const isAllSame = delays.every(d => d === delays[0]);

    expect(isAllSame).toBe(false);
  });
});
