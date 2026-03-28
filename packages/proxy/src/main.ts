import { resolve } from 'node:path';
import { loadProxyConfig, loadServerConfig } from './config.js';
import type { ServerConfig } from './types.js';
import { LspProxy } from './proxy.js';
import { log } from './logger.js';

const parseConfigDir = (): string | undefined => {
  const idx = process.argv.indexOf('--config-dir');
  const arg = process.argv[idx + 1];
  if (idx < 0 || !arg) return undefined;
  return resolve(arg);
};

const main = async (): Promise<void> => {
  const configDir = parseConfigDir();
  const proxyConfig = await loadProxyConfig(configDir);

  const serverConfigs = new Map(
    await Promise.all(
      proxyConfig.servers.map(async (name): Promise<[string, ServerConfig]> => {
        const config = await loadServerConfig(name, configDir);
        log.info(`Loaded server config: ${name}`);
        return [name, config];
      }),
    ),
  );

  const proxy = new LspProxy(serverConfigs, {
    watcherExclude: proxyConfig.watcherExclude,
  });
  log.info('Proxy ready — waiting for client');
  await proxy.start();
  process.exit(0);
};

main().catch((err: unknown) => {
  log.error('Fatal:', err);
  process.exit(1);
});
