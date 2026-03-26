import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProxyConfig, loadServerConfig } from './config.js';
import { log } from './logger.js';

const baseDir = join(dirname(fileURLToPath(import.meta.url)), '..');

const buildExtensionToLanguage = (
  servers: ReadonlyArray<{ languages: Readonly<Record<string, readonly string[]>> }>,
): Record<string, string> =>
  Object.fromEntries(
    servers.flatMap(({ languages }) =>
      Object.entries(languages).flatMap(([langId, exts]) =>
        exts.map((ext) => [ext, langId]),
      ),
    ),
  );

const main = async (): Promise<void> => {
  const proxyConfig = await loadProxyConfig();
  const serverConfigs = await Promise.all(
    proxyConfig.servers.map((name) => loadServerConfig(name)),
  );

  const extensionToLanguage = buildExtensionToLanguage(serverConfigs);

  const lspJson = {
    'lsp-proxy': {
      command: 'node',
      args: [join(baseDir, 'dist', 'main.js')],
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

  await writeFile(join(baseDir, '.lsp.json'), JSON.stringify(lspJson, null, 2) + '\n');
  await mkdir(join(baseDir, '.claude-plugin'), { recursive: true });
  await writeFile(
    join(baseDir, '.claude-plugin', 'plugin.json'),
    JSON.stringify(pluginJson, null, 2) + '\n',
  );

  const extCount = Object.keys(extensionToLanguage).length;
  log.info(`Generated .lsp.json (${extCount} extensions from ${proxyConfig.servers.join(', ')})`);
  log.info('Generated .claude-plugin/plugin.json');
};

main().catch((err) => {
  log.error('Fatal:', err);
  process.exit(1);
});
