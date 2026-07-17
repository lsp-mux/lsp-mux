import { createClock } from '@sinonjs/fake-timers';
import { describe, it, vi } from 'vitest';
import { createFlushScheduler } from '../src/flush-scheduler.ts';
import type { FlushSchedulerOptions } from '../src/flush-scheduler.ts';

describe('FlushScheduler', () => {
  it('calls onFlush after debounceMs', async ({ expect }) => {
    const clock = createClock();
    const onFlush = vi.fn<FlushSchedulerOptions['onFlush']>().mockResolvedValue(undefined);
    const scheduler = createFlushScheduler({ debounceMs: 100, maxWaitMs: 1000, onFlush, timers: clock });

    scheduler.notify();

    expect(onFlush).not.toHaveBeenCalled();

    await clock.tickAsync(100);

    expect(onFlush).toHaveBeenCalledTimes(1);

    scheduler.dispose();
  });

  it('resets debounce on each notify', async ({ expect }) => {
    const clock = createClock();
    const onFlush = vi.fn<FlushSchedulerOptions['onFlush']>().mockResolvedValue(undefined);
    const scheduler = createFlushScheduler({ debounceMs: 100, maxWaitMs: 2000, onFlush, timers: clock });

    scheduler.notify();
    await clock.tickAsync(80);
    scheduler.notify(); // reset debounce
    await clock.tickAsync(80);

    expect(onFlush).not.toHaveBeenCalled(); // only 80ms since last notify

    await clock.tickAsync(20);

    expect(onFlush).toHaveBeenCalledTimes(1);

    scheduler.dispose();
  });

  it('forces flush at maxWaitMs even when debounce keeps resetting', async ({ expect }) => {
    const clock = createClock();
    const onFlush = vi.fn<FlushSchedulerOptions['onFlush']>().mockResolvedValue(undefined);
    const scheduler = createFlushScheduler({ debounceMs: 100, maxWaitMs: 300, onFlush, timers: clock });

    // Notify every 50ms — debounce (100ms) never fires
    scheduler.notify();
    for (let iteration = 0; iteration < 5; iteration++) {
      await clock.tickAsync(50);
      scheduler.notify();
    }

    // 250ms elapsed, debounce hasn'clock fired
    expect(onFlush).not.toHaveBeenCalled();

    await clock.tickAsync(50); // 300ms total → maxWait fires

    expect(onFlush).toHaveBeenCalledTimes(1);

    scheduler.dispose();
  });

  it('re-enters debounce cycle when notified during flush (not immediate)', async ({ expect }) => {
    const clock = createClock();
    let flushCount = 0;
    const onFlush = vi.fn<FlushSchedulerOptions['onFlush']>().mockResolvedValue(undefined);
    const scheduler = createFlushScheduler({ debounceMs: 100, maxWaitMs: 1000, onFlush, timers: clock });

    onFlush.mockImplementation(() => {
      flushCount++;
      if (flushCount === 1) {
        scheduler.notify();
      }
      return Promise.resolve();
    });

    scheduler.notify();
    await clock.tickAsync(100); // first flush fires

    // Re-check should NOT fire immediately — it goes through debounce
    await clock.tickAsync(1);

    expect(onFlush).toHaveBeenCalledTimes(1); // still just the first flush

    // After debounceMs, the re-check flush fires
    await clock.tickAsync(99);

    expect(onFlush).toHaveBeenCalledTimes(2);

    scheduler.dispose();
  });

  it('does not run concurrent flushes', async ({ expect }) => {
    const clock = createClock();
    const { promise: flushPromise, resolve: resolveFlush }: PromiseWithResolvers<void> = Promise.withResolvers();
    const onFlush = vi.fn<FlushSchedulerOptions['onFlush']>().mockReturnValueOnce(flushPromise).mockResolvedValue(undefined);
    const scheduler = createFlushScheduler({ debounceMs: 50, maxWaitMs: 1000, onFlush, timers: clock });

    scheduler.notify();
    await clock.tickAsync(50); // first flush starts (blocked)

    expect(onFlush).toHaveBeenCalledTimes(1);

    scheduler.notify(); // arrives during flush
    await clock.tickAsync(50); // debounce would fire, but flush is in progress

    expect(onFlush).toHaveBeenCalledTimes(1); // still only one call

    resolveFlush(); // unblock first flush
    await clock.tickAsync(0); // let first flush complete

    expect(onFlush).toHaveBeenCalledTimes(1); // re-check goes through debounce, not immediate

    await clock.tickAsync(50); // debounce fires

    expect(onFlush).toHaveBeenCalledTimes(2); // second flush from debounced re-check

    scheduler.dispose();
  });

  it('dispose cancels pending timers', async ({ expect }) => {
    const clock = createClock();
    const onFlush = vi.fn<FlushSchedulerOptions['onFlush']>().mockResolvedValue(undefined);
    const scheduler = createFlushScheduler({ debounceMs: 100, maxWaitMs: 1000, onFlush, timers: clock });

    scheduler.notify();
    scheduler.dispose();

    await clock.tickAsync(200);

    expect(onFlush).not.toHaveBeenCalled();
  });

  it('recovers after onFlush throws', async ({ expect }) => {
    const clock = createClock();
    const onFlush = vi.fn<FlushSchedulerOptions['onFlush']>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(undefined);
    const scheduler = createFlushScheduler({ debounceMs: 100, maxWaitMs: 1000, onFlush, timers: clock });

    scheduler.notify();
    await clock.tickAsync(100); // first flush fires and throws

    expect(onFlush).toHaveBeenCalledTimes(1);

    // Scheduler should not be stuck — a new notify should trigger another flush
    scheduler.notify();
    await clock.tickAsync(100);

    expect(onFlush).toHaveBeenCalledTimes(2);

    scheduler.dispose();
  });

  it('does not flush after dispose', async ({ expect }) => {
    const clock = createClock();
    const onFlush = vi.fn<FlushSchedulerOptions['onFlush']>().mockResolvedValue(undefined);
    const scheduler = createFlushScheduler({ debounceMs: 100, maxWaitMs: 1000, onFlush, timers: clock });

    scheduler.dispose();
    scheduler.notify(); // should be a no-op

    await clock.tickAsync(200);

    expect(onFlush).not.toHaveBeenCalled();
  });

  it('resets maxWait timer after flush completes', async ({ expect }) => {
    const clock = createClock();
    const onFlush = vi.fn<FlushSchedulerOptions['onFlush']>().mockResolvedValue(undefined);
    const scheduler = createFlushScheduler({ debounceMs: 100, maxWaitMs: 300, onFlush, timers: clock });

    // First batch
    scheduler.notify();
    await clock.tickAsync(100);

    expect(onFlush).toHaveBeenCalledTimes(1);

    // Second batch — maxWait should restart from now, not from the first notify
    scheduler.notify();
    await clock.tickAsync(100);

    expect(onFlush).toHaveBeenCalledTimes(2);

    scheduler.dispose();
  });
});
