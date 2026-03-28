import { createClock } from '@sinonjs/fake-timers';
import { describe, it, vi } from 'vitest';
import { createFlushScheduler } from '../src/flush-scheduler.js';

describe('FlushScheduler', () => {
  it('calls onFlush after debounceMs', async ({ expect }) => {
    const t = createClock();
    const onFlush = vi.fn().mockResolvedValue(undefined);
    const scheduler = createFlushScheduler({ debounceMs: 100, maxWaitMs: 1000, onFlush, timers: t });

    scheduler.notify();
    expect(onFlush).not.toHaveBeenCalled();

    await t.tickAsync(100);
    expect(onFlush).toHaveBeenCalledOnce();

    scheduler.dispose();
  });

  it('resets debounce on each notify', async ({ expect }) => {
    const t = createClock();
    const onFlush = vi.fn().mockResolvedValue(undefined);
    const scheduler = createFlushScheduler({ debounceMs: 100, maxWaitMs: 2000, onFlush, timers: t });

    scheduler.notify();
    await t.tickAsync(80);
    scheduler.notify(); // reset debounce
    await t.tickAsync(80);
    expect(onFlush).not.toHaveBeenCalled(); // only 80ms since last notify

    await t.tickAsync(20);
    expect(onFlush).toHaveBeenCalledOnce();

    scheduler.dispose();
  });

  it('forces flush at maxWaitMs even when debounce keeps resetting', async ({ expect }) => {
    const t = createClock();
    const onFlush = vi.fn().mockResolvedValue(undefined);
    const scheduler = createFlushScheduler({ debounceMs: 100, maxWaitMs: 300, onFlush, timers: t });

    // Notify every 50ms — debounce (100ms) never fires
    scheduler.notify();
    for (let i = 0; i < 5; i++) {
      await t.tickAsync(50);
      scheduler.notify();
    }
    // 250ms elapsed, debounce hasn't fired
    expect(onFlush).not.toHaveBeenCalled();

    await t.tickAsync(50); // 300ms total → maxWait fires
    expect(onFlush).toHaveBeenCalledOnce();

    scheduler.dispose();
  });

  it('re-enters debounce cycle when notified during flush (not immediate)', async ({ expect }) => {
    const t = createClock();
    let flushCount = 0;
    const onFlush = vi.fn().mockResolvedValue(undefined);
    const scheduler = createFlushScheduler({ debounceMs: 100, maxWaitMs: 1000, onFlush, timers: t });

    onFlush.mockImplementation(() => {
      flushCount++;
      if (flushCount === 1) {
        scheduler.notify();
      }
      return Promise.resolve();
    });

    scheduler.notify();
    await t.tickAsync(100); // first flush fires

    // Re-check should NOT fire immediately — it goes through debounce
    await t.tickAsync(1);
    expect(onFlush).toHaveBeenCalledTimes(1); // still just the first flush

    // After debounceMs, the re-check flush fires
    await t.tickAsync(99);
    expect(onFlush).toHaveBeenCalledTimes(2);

    scheduler.dispose();
  });

  it('does not run concurrent flushes', async ({ expect }) => {
    const t = createClock();
    let resolveFlush!: () => void;
    const flushPromise = new Promise<void>((r) => {
      resolveFlush = r;
    });
    const onFlush = vi.fn().mockReturnValueOnce(flushPromise).mockResolvedValue(undefined);
    const scheduler = createFlushScheduler({ debounceMs: 50, maxWaitMs: 1000, onFlush, timers: t });

    scheduler.notify();
    await t.tickAsync(50); // first flush starts (blocked)
    expect(onFlush).toHaveBeenCalledOnce();

    scheduler.notify(); // arrives during flush
    await t.tickAsync(50); // debounce would fire, but flush is in progress
    expect(onFlush).toHaveBeenCalledOnce(); // still only one call

    resolveFlush(); // unblock first flush
    await t.tickAsync(0); // let first flush complete
    expect(onFlush).toHaveBeenCalledOnce(); // re-check goes through debounce, not immediate

    await t.tickAsync(50); // debounce fires
    expect(onFlush).toHaveBeenCalledTimes(2); // second flush from debounced re-check

    scheduler.dispose();
  });

  it('dispose cancels pending timers', async ({ expect }) => {
    const t = createClock();
    const onFlush = vi.fn().mockResolvedValue(undefined);
    const scheduler = createFlushScheduler({ debounceMs: 100, maxWaitMs: 1000, onFlush, timers: t });

    scheduler.notify();
    scheduler.dispose();

    await t.tickAsync(200);
    expect(onFlush).not.toHaveBeenCalled();
  });

  it('recovers after onFlush throws', async ({ expect }) => {
    const t = createClock();
    const onFlush = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(undefined);
    const scheduler = createFlushScheduler({ debounceMs: 100, maxWaitMs: 1000, onFlush, timers: t });

    scheduler.notify();
    await t.tickAsync(100); // first flush fires and throws
    expect(onFlush).toHaveBeenCalledOnce();

    // Scheduler should not be stuck — a new notify should trigger another flush
    scheduler.notify();
    await t.tickAsync(100);
    expect(onFlush).toHaveBeenCalledTimes(2);

    scheduler.dispose();
  });

  it('does not flush after dispose', async ({ expect }) => {
    const t = createClock();
    const onFlush = vi.fn().mockResolvedValue(undefined);
    const scheduler = createFlushScheduler({ debounceMs: 100, maxWaitMs: 1000, onFlush, timers: t });

    scheduler.dispose();
    scheduler.notify(); // should be a no-op

    await t.tickAsync(200);
    expect(onFlush).not.toHaveBeenCalled();
  });

  it('resets maxWait timer after flush completes', async ({ expect }) => {
    const t = createClock();
    const onFlush = vi.fn().mockResolvedValue(undefined);
    const scheduler = createFlushScheduler({ debounceMs: 100, maxWaitMs: 300, onFlush, timers: t });

    // First batch
    scheduler.notify();
    await t.tickAsync(100);
    expect(onFlush).toHaveBeenCalledOnce();

    // Second batch — maxWait should restart from now, not from the first notify
    scheduler.notify();
    await t.tickAsync(100);
    expect(onFlush).toHaveBeenCalledTimes(2);

    scheduler.dispose();
  });
});
