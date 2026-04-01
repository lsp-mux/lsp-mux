import { entries } from './entries.generated.js';

export { deepMerge } from './deep-merge.js';
export { validateNpmPackage } from './npm-validate.js';

export interface RegistryEntry {
  /** npm package that provides this server's binary. */
  readonly npm?: string;
  /** Server config fields (command, args, languages, etc.) */
  readonly [key: string]: unknown;
}

/** Look up a registry entry by server name. Returns undefined if not found. */
export const lookupRegistryEntry = (
  name: string,
): RegistryEntry | undefined =>
  entries[name];

const METADATA_KEYS: ReadonlySet<string> = new Set(['npm']);

/** Return the server config fields from a registry entry (strips registry metadata). */
export const serverConfigFromEntry = (entry: RegistryEntry): Record<string, unknown> =>
  Object.fromEntries(Object.entries(entry).filter(([k]) => !METADATA_KEYS.has(k)));

/** List all server names available in the registry. */
export const listRegistryEntries = (): readonly string[] =>
  Object.keys(entries);
