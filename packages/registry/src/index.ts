import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPlainObject } from './utils.js';

export { deepMerge } from './deep-merge.js';
export { validateNpmPackage } from './npm-validate.js';

export interface RegistryEntry {
  /** npm package that provides this server's binary. */
  readonly npm?: string;
  /** Server config fields (command, args, languages, etc.) */
  readonly [key: string]: unknown;
}

const entriesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'entries');

const parseJsonFile = async (path: string): Promise<Record<string, unknown>> => {
  const text = await readFile(path, 'utf-8');
  const parsed: unknown = JSON.parse(text);
  if (!isPlainObject(parsed)) {
    throw new Error(`Expected JSON object in ${path}`);
  }
  return parsed;
};

/** Look up a registry entry by server name. Returns undefined if not found. */
export const lookupRegistryEntry = async (
  name: string,
): Promise<RegistryEntry | undefined> => {
  try {
    return await parseJsonFile(join(entriesDir, `${name}.json`));
  }
  catch (err: unknown) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return undefined;
    throw err;
  }
};

const METADATA_KEYS: ReadonlySet<string> = new Set(['npm']);

/** Return the server config fields from a registry entry (strips registry metadata). */
export const serverConfigFromEntry = (entry: RegistryEntry): Record<string, unknown> =>
  Object.fromEntries(Object.entries(entry).filter(([k]) => !METADATA_KEYS.has(k)));

/** List all server names available in the registry. */
export const listRegistryEntries = async (): Promise<readonly string[]> => {
  const files = await readdir(entriesDir);
  return files
    .filter(f => f.endsWith('.json'))
    .map(f => basename(f, '.json'));
};
