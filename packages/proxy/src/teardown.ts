/*
 * Stopping the servers the proxy started. Separate from `ManagedServer` so
 * the whole-set concern sits beside the proxy that owns the set, rather than
 * inside the type it stops.
 */
import { defaultExitGracePeriodMs } from './child-server.ts';
import type { ManagedServer } from './managed-server.ts';

/**
 * Stop every server at once, each getting the grace period to act on the
 * `exit` it is sent. Settled rather than raced: a server that fails to stop
 * must not strand the caller waiting on the rest, which for the proxy means
 * a teardown that never finishes and a process that never exits.
 */
export const stopAllServers = async (
  servers: Iterable<ManagedServer>,
  gracePeriodMs = defaultExitGracePeriodMs,
): Promise<void> => {
  await Promise.allSettled([...servers].map(server => server.stop(gracePeriodMs)));
};
