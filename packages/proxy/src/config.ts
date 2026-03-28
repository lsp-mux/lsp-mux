import { readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as v from 'valibot';
import { ProxyConfigSchema, ServerConfigSchema } from './config-schema.js';
import type { ProxyConfig, ServerConfig } from './config-schema.js';

export const ownPackageDir = join(dirname(fileURLToPath(import.meta.url)), '..');

const parseJsonFile = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(path, 'utf-8'));

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
): Promise<ProxyConfig> =>
  v.parse(ProxyConfigSchema, await parseJsonFile(join(configDir, 'proxy.config.json')));

export const loadServerConfig = async (
  name: string,
  configDir = ownPackageDir,
): Promise<ServerConfig> => {
  // basename on POSIX doesn't treat '\' as a separator, so check explicitly
  if (basename(name) !== name || name.includes('\\')) {
    throw new Error(`Invalid server name: ${name}`);
  }
  const raw = v.parse(ServerConfigSchema, await parseJsonFile(join(configDir, 'servers', `${name}.json`)));
  return resolveServerPaths(raw, configDir);
};
