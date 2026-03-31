import { readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as v from 'valibot';
import {
  lookupRegistryEntry, serverConfigFromEntry,
  deepMerge, validateNpmPackage,
} from 'lsp-proxy-registry';

const CONFIG_FILE = '.lsp-proxy.json';
const LOCAL_CONFIG_FILE = '.lsp-proxy.local.json';
import { ProxyConfigSchema, ServerConfigSchema } from './config-schema.js';
import type { ProxyConfig, ServerConfig } from './config-schema.js';

export const ownPackageDir = join(dirname(fileURLToPath(import.meta.url)), '..');

const parseJsonFile = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(path, 'utf-8'));

const tryLoadJsonFile = async (path: string): Promise<Record<string, unknown> | undefined> => {
  try {
    const raw: unknown = await parseJsonFile(path);
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
      return raw as Record<string, unknown>;
    }
    return undefined;
  }
  catch (err: unknown) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return undefined;
    throw err;
  }
};

const isRelativePath = (p: string): boolean =>
  p.startsWith('./') || p.startsWith('../');

const resolveRelative = (p: string, baseDir: string): string =>
  isRelativePath(p) ? resolve(baseDir, p) : p;

const resolveServerPaths = (config: ServerConfig, configDir: string): ServerConfig => ({
  ...config,
  command: resolveRelative(config.command, configDir),
  args: config.args.map(a => resolveRelative(a, configDir)),
});

export const loadProxyConfig = async (
  configDir = ownPackageDir,
): Promise<ProxyConfig> => {
  const base = await parseJsonFile(join(configDir, CONFIG_FILE));
  const local = await tryLoadJsonFile(join(configDir, LOCAL_CONFIG_FILE));
  const merged = local ? deepMerge(base as Record<string, unknown>, local) : base;
  return v.parse(ProxyConfigSchema, merged);
};

export const loadServerConfig = async (
  name: string,
  configDir = ownPackageDir,
): Promise<ServerConfig> => {
  // basename on POSIX doesn't treat '\' as a separator, so check explicitly
  if (basename(name) !== name || name.includes('\\')) {
    throw new Error(`Invalid server name: ${name}`);
  }

  const [registryEntry, userOverride] = await Promise.all([
    lookupRegistryEntry(name),
    tryLoadJsonFile(join(configDir, 'servers', `${name}.json`)),
  ]);

  const base = registryEntry
    ? serverConfigFromEntry(registryEntry)
    : undefined;
  const merged = base && userOverride
    ? deepMerge(base, userOverride)
    : base ?? userOverride;

  if (!merged) {
    throw new Error(
      `Server "${name}" not found in registry or in servers/${name}.json`,
    );
  }

  const validated = v.parse(ServerConfigSchema, merged);

  // Skip npm check when user overrides the command — they're taking
  // ownership of where the server binary lives.
  if (registryEntry?.npm && !userOverride?.['command']) {
    await validateNpmPackage(registryEntry.npm, configDir, name);
  }

  return resolveServerPaths(validated, configDir);
};
