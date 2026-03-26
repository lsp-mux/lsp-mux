import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRestartScheduler } from '../src/restart-scheduler.js';

describe('RestartScheduler', () => {
  afterEach(() => vi.restoreAllMocks());

  const policy = { maxRetries: 3, baseDelayMs: 100, maxDelayMs: 500 };

  it('schedules with exponential backoff', () => {
    vi.useFakeTimers();
    const sched = createRestartScheduler(policy);
    const calls: number[] = [];

    // Attempt 1: 100 * 2^0 = 100ms
    expect(sched.schedule(() => calls.push(1))).toBe(true);
    expect(sched.attempt).toBe(1);
    vi.advanceTimersByTime(100);
    expect(calls).toEqual([1]);

    // Attempt 2: 100 * 2^1 = 200ms
    expect(sched.schedule(() => calls.push(2))).toBe(true);
    expect(sched.attempt).toBe(2);
    vi.advanceTimersByTime(200);
    expect(calls).toEqual([1, 2]);

    // Attempt 3: 100 * 2^2 = 400ms
    expect(sched.schedule(() => calls.push(3))).toBe(true);
    expect(sched.attempt).toBe(3);
    vi.advanceTimersByTime(400);
    expect(calls).toEqual([1, 2, 3]);

    // Attempt 4: over maxRetries
    expect(sched.schedule(() => calls.push(4))).toBe(false);
    expect(sched.attempt).toBe(3);
  });

  it('caps delay at maxDelayMs', () => {
    vi.useFakeTimers();
    const sched = createRestartScheduler({ maxRetries: 10, baseDelayMs: 100, maxDelayMs: 300 });
    const calls: number[] = [];

    // Attempt 1: 100ms
    sched.schedule(() => calls.push(1));
    vi.advanceTimersByTime(100);

    // Attempt 2: 200ms
    sched.schedule(() => calls.push(2));
    vi.advanceTimersByTime(200);

    // Attempt 3: min(400, 300) = 300ms (capped)
    sched.schedule(() => calls.push(3));
    vi.advanceTimersByTime(299);
    expect(calls).toEqual([1, 2]);
    vi.advanceTimersByTime(1);
    expect(calls).toEqual([1, 2, 3]);
  });

  it('reset restores attempt counter', () => {
    vi.useFakeTimers();
    const sched = createRestartScheduler(policy);

    sched.schedule(() => {});
    vi.advanceTimersByTime(100);
    sched.schedule(() => {});
    vi.advanceTimersByTime(200);
    expect(sched.attempt).toBe(2);

    sched.reset();
    expect(sched.attempt).toBe(0);

    // Should schedule from attempt 1 again
    const called = vi.fn();
    expect(sched.schedule(called)).toBe(true);
    expect(sched.attempt).toBe(1);
    vi.advanceTimersByTime(100);
    expect(called).toHaveBeenCalledOnce();
  });

  it('cancel prevents pending callback', () => {
    vi.useFakeTimers();
    const sched = createRestartScheduler(policy);
    const called = vi.fn();

    sched.schedule(called);
    sched.cancel();
    vi.advanceTimersByTime(1000);
    expect(called).not.toHaveBeenCalled();
  });

  it('exposes maxRetries from policy', () => {
    const sched = createRestartScheduler(policy);
    expect(sched.maxRetries).toBe(3);
  });
});
