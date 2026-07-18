import { isPlainObject } from './capabilities.ts';

export interface CompensationFlags {
  /** True when the client lacks workspace/didChangeWatchedFiles — proxy watches files locally. */
  readonly localFileWatching: boolean;
  /**
   * True when the client lacks textDocument/diagnostic — proxy proactively
   * pulls and republishes as push.
   */
  readonly proactivePullDiagnostics: boolean;
}

/**
 * Inspect client capabilities from the initialize params and determine
 * which features the proxy must compensate for.
 *
 * - `localFileWatching`: clients that advertise
 *   `workspace.didChangeWatchedFiles.dynamicRegistration` handle file
 *   watching natively; others get the proxy's built-in WorkspaceWatcher.
 * - `proactivePullDiagnostics`: clients that advertise
 *   `textDocument.diagnostic` support the pull diagnostic model natively;
 *   others need the proxy to proactively pull after document changes and
 *   republish results via push.
 */
export const analyzeClientCapabilities = (params: unknown): CompensationFlags => {
  const base = isPlainObject(params) ? params : {};
  const caps = isPlainObject(base['capabilities']) ? base['capabilities'] : {};
  const workspace = isPlainObject(caps['workspace']) ? caps['workspace'] : {};
  const textDocument = isPlainObject(caps['textDocument']) ? caps['textDocument'] : {};
  const dcwf = isPlainObject(workspace['didChangeWatchedFiles'])
    ? workspace['didChangeWatchedFiles']
    : {};
  const diag = isPlainObject(textDocument['diagnostic'])
    ? textDocument['diagnostic']
    : {};

  return {
    localFileWatching: dcwf['dynamicRegistration'] !== true,
    proactivePullDiagnostics: diag['dynamicRegistration'] !== true,
  };
};

/**
 * Ensures child servers see capabilities the proxy handles.
 *
 * - `didChangeConfiguration` is always injected — the proxy manages per-server
 *   settings delivery regardless of client support.
 * - `didChangeWatchedFiles` is only injected when the proxy compensates for a
 *   client that lacks native file watching (localFileWatching).
 */
export const injectProxyCapabilities = (
  params: unknown,
  compensations: CompensationFlags,
): object => {
  const base = isPlainObject(params) ? params : {};
  const caps = isPlainObject(base['capabilities']) ? base['capabilities'] : {};
  const workspace = isPlainObject(caps['workspace']) ? caps['workspace'] : {};
  const dcc = isPlainObject(workspace['didChangeConfiguration'])
    ? workspace['didChangeConfiguration']
    : {};

  const workspaceOverrides: Record<string, unknown> = {
    ...workspace,
    didChangeConfiguration: { ...dcc, dynamicRegistration: true },
  };

  if (compensations.localFileWatching) {
    const dcwf = isPlainObject(workspace['didChangeWatchedFiles'])
      ? workspace['didChangeWatchedFiles']
      : {};
    workspaceOverrides['didChangeWatchedFiles'] = { ...dcwf, dynamicRegistration: true };
  }

  return {
    ...base,
    capabilities: {
      ...caps,
      workspace: workspaceOverrides,
    },
  };
};
