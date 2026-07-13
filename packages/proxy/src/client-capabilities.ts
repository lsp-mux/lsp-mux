import { isPlainObject } from './capabilities.ts';

export interface CompensationFlags {
  /** True when the client lacks workspace/didChangeWatchedFiles — proxy watches files locally. */
  readonly localFileWatching: boolean;
  /** True when the client lacks textDocument/diagnostic — proxy proactively pulls and republishes as push. */
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
