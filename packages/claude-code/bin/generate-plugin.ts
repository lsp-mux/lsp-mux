#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadProxyConfig, loadServerConfig, ownPackageDir } from 'lsp-proxy/config';
import { createLogger } from 'lsp-proxy/logger';

const log = createLogger();

const buildExtensionToLanguage = (
  servers: readonly { languages: Readonly<Record<string, readonly string[]>> }[],
): Record<string, string> =>
  Object.fromEntries(
    servers.flatMap(({ languages }) =>
      Object.entries(languages).flatMap(([langId, exts]) =>
        exts.map(ext => [ext, langId]),
      ),
    ),
  );

const main = async (): Promise<void> => {
  const configDir = process.cwd();
  const proxyConfig = await loadProxyConfig(configDir);
  const serverConfigs = await Promise.all(
    proxyConfig.servers.map(name => loadServerConfig(name, configDir)),
  );

  const extensionToLanguage = buildExtensionToLanguage(serverConfigs);

  const lspJson = {
    'lsp-proxy': {
      command: 'node',
      args: [join(ownPackageDir, 'dist', 'main.js'), '--config-dir', configDir],
      extensionToLanguage,
      transport: 'stdio',
      initializationOptions: {},
      settings: {},
      maxRestarts: 0,
    },
  };

  const pluginJson = {
    name: 'lsp-proxy',
    version: '0.1.0',
    description: 'Multiplexing LSP proxy for Claude Code',
  };

  const marketplaceJson = {
    name: 'lsp-proxy',
    owner: { name: 'lsp-proxy' },
    plugins: [{ name: 'lsp-proxy', source: './', description: pluginJson.description }],
  };

  await writeFile(join(configDir, '.lsp.json'), JSON.stringify(lspJson, null, 2) + '\n');
  const pluginDir = join(configDir, '.claude-plugin');
  await mkdir(pluginDir, { recursive: true });
  await writeFile(join(pluginDir, 'plugin.json'), JSON.stringify(pluginJson, null, 2) + '\n');
  await writeFile(join(pluginDir, 'marketplace.json'), JSON.stringify(marketplaceJson, null, 2) + '\n');

  const extCount = Object.keys(extensionToLanguage).length;
  log.info(`Generated .lsp.json (${String(extCount)} extensions from ${proxyConfig.servers.join(', ')})`);
  log.info('Generated .claude-plugin/plugin.json');
  log.info('Generated .claude-plugin/marketplace.json');
};

main().catch((err: unknown) => {
  log.error('Fatal:', err);
  process.exit(1);
});
