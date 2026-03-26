import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as v from 'valibot';
import { ProxyConfigSchema, ServerConfigSchema } from './config-schema.js';
import type { ProxyConfig, ServerConfig } from './config-schema.js';

const baseDir = join(dirname(fileURLToPath(import.meta.url)), '..');

const parseJsonFile = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(path, 'utf-8'));

export const loadProxyConfig = async (
  path = join(baseDir, 'proxy.config.json'),
): Promise<ProxyConfig> => v.parse(ProxyConfigSchema, await parseJsonFile(path));

export const loadServerConfig = async (
  name: string,
  dir = join(baseDir, 'servers'),
): Promise<ServerConfig> =>
  v.parse(ServerConfigSchema, await parseJsonFile(join(dir, `${name}.json`)));
