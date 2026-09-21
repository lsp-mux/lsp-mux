import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deepMerge, lookupRegistryEntry,
  serverConfigFromEntry, validateNpmPackage,
} from 'lsp-proxy-registry';
import * as v from 'valibot';
import { ProxyConfigSchema, ServerConfigSchema } from './config-schema.ts';
import type { ProxyConfig, ServerConfig } from './config-schema.ts';

/**
 * Re-parses settings after path resolution, which widens their type to unknown.
 */
const SettingsRecordSchema = v.record(v.string(), v.unknown());

const configFile = '.lsp-proxy.json';
const localConfigFile = '.lsp-proxy.local.json';

const selfPath = fileURLToPath(import.meta.url);
const selfDir = path.dirname(selfPath);

export const ownPackageDir = path.join(selfDir, '..');

/**
 * Resolved path to the proxy entry point (bin/main), stable across workspace
 *  (.ts source) and published (.js) layouts — extension follows this module.
 */
export const proxyMainEntry = path.join(selfDir, '..', 'bin', `main${path.extname(selfPath)}`);

const parseJsonFile = async (filePath: string): Promise<unknown> =>
  JSON.parse(await readFile(filePath, 'utf8'));

const tryLoadJsonFile = async (filePath: string): Promise<Record<string, unknown> | undefined> => {
  try {
    const raw: unknown = await parseJsonFile(filePath);
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
      return raw as Record<string, unknown>;
    }
    return undefined;
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
};

const isRelativePath = (filePath: string): boolean =>
  filePath.startsWith('./') || filePath.startsWith('../');

const resolveRelative = (filePath: string, baseDir: string): string =>
  isRelativePath(filePath) ? path.resolve(baseDir, filePath) : filePath;

/*
 * Settings reach a server verbatim, and some of them are paths: vtsls locates
 * a tsserver plugin by one. A config that has to spell those absolutely is not
 * portable, so they resolve the same way command and args do — which is also
 * why the rule is the prefix rather than the key, since the proxy has no idea
 * which of a server's settings name files.
 */
const resolveSettingPaths = (value: unknown, configDir: string): unknown => {
  if (typeof value === 'string') return resolveRelative(value, configDir);
  if (Array.isArray(value)) return value.map(item => resolveSettingPaths(item, configDir));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolveSettingPaths(item, configDir)]),
    );
  }
  return value;
};

const resolveServerPaths = (config: ServerConfig, configDir: string): ServerConfig => ({
  ...config,
  command: resolveRelative(config.command, configDir),
  args: config.args.map(arg => resolveRelative(arg, configDir)),
  ...(config.settings && {
    settings: v.parse(SettingsRecordSchema, resolveSettingPaths(config.settings, configDir)),
  }),
});

export const loadProxyConfig = async (
  configDir = ownPackageDir,
): Promise<ProxyConfig> => {
  const base = await parseJsonFile(path.join(configDir, configFile));
  const local = await tryLoadJsonFile(path.join(configDir, localConfigFile));
  const merged = local ? deepMerge(base as Record<string, unknown>, local) : base;
  return v.parse(ProxyConfigSchema, merged);
};

const assertValidServerName = (name: string): void => {
  // basename on POSIX doesn't treat '\' as a separator, so check explicitly
  if (path.basename(name) !== name || name.includes('\\')) {
    throw new Error(`Invalid server name: ${name}`);
  }
};

const validateNpmIfNeeded = async (
  registryEntry: ReturnType<typeof lookupRegistryEntry>,
  userOverride: Record<string, unknown> | undefined,
  configDir: string,
  name: string,
): Promise<void> => {
  // Skip npm check when user overrides the command — they're taking
  // ownership of where the server binary lives.
  if (registryEntry?.npm && !userOverride?.['command']) {
    await validateNpmPackage(registryEntry.npm, configDir, name);
  }
};

export const loadServerConfig = async (
  name: string,
  configDir = ownPackageDir,
): Promise<ServerConfig> => {
  assertValidServerName(name);

  const registryEntry = lookupRegistryEntry(name);
  const userOverride = await tryLoadJsonFile(path.join(configDir, 'servers', `${name}.json`));

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

  await validateNpmIfNeeded(registryEntry, userOverride, configDir, name);

  return resolveServerPaths(validated, configDir);
};
