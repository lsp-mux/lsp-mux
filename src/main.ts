import { loadProxyConfig, loadServerConfig } from './config.js';
import { LspProxy } from './proxy.js';
import { log } from './logger.js';

const main = async (): Promise<void> => {
  const proxyConfig = await loadProxyConfig();

  const [serverName] = proxyConfig.servers;
  if (!serverName) {
    log.error('No servers configured in proxy.config.json');
    process.exit(1);
  }

  const serverConfig = await loadServerConfig(serverName);
  log.info(`Loaded server config: ${serverName}`);

  const proxy = new LspProxy(serverName, serverConfig);
  log.info('Proxy ready — waiting for client');
  await proxy.start();
  process.exit(0);
};

main().catch((err) => {
  log.error('Fatal:', err);
  process.exit(1);
});
