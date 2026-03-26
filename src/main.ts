import { loadProxyConfig, loadServerConfig } from './config.js';
import type { ServerConfig } from './types.js';
import { LspProxy } from './proxy.js';
import { log } from './logger.js';

const main = async (): Promise<void> => {
  const proxyConfig = await loadProxyConfig();

  const serverConfigs = new Map<string, ServerConfig>();
  for (const name of proxyConfig.servers) {
    serverConfigs.set(name, await loadServerConfig(name));
    log.info(`Loaded server config: ${name}`);
  }

  const proxy = new LspProxy(serverConfigs);
  log.info('Proxy ready — waiting for client');
  await proxy.start();
  process.exit(0);
};

main().catch((err: unknown) => {
  log.error('Fatal:', err);
  process.exit(1);
});
