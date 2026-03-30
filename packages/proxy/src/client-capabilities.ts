import { isPlainObject } from './capabilities.js';

export interface CompensationFlags {
  /** True when the client lacks workspace/didChangeWatchedFiles — proxy watches files locally. */
  readonly localFileWatching: boolean;
}

/**
 * Inspect client capabilities from the initialize params and determine
 * which features the proxy must compensate for.
 *
 * Clients that advertise `workspace.didChangeWatchedFiles.dynamicRegistration`
 * handle file watching natively — the proxy forwards watcher registrations
 * to them. Clients that don't (e.g., Claude Code) get local file watching
 * via the proxy's built-in WorkspaceWatcher.
 */
export const analyzeClientCapabilities = (params: unknown): CompensationFlags => {
  const base = isPlainObject(params) ? params : {};
  const caps = isPlainObject(base['capabilities']) ? base['capabilities'] : {};
  const workspace = isPlainObject(caps['workspace']) ? caps['workspace'] : {};
  const dcwf = isPlainObject(workspace['didChangeWatchedFiles'])
    ? workspace['didChangeWatchedFiles']
    : {};

  return {
    localFileWatching: dcwf['dynamicRegistration'] !== true,
  };
};
