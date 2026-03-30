import { createWriteStream, mkdirSync, watch } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import * as v from 'valibot';
import { loadProxyConfig, loadServerConfig, ownPackageDir } from './config.js';
import { ProxyConfigSchema } from './config-schema.js';
import type { ServerConfig } from './types.js';
import { LspProxy } from './proxy.js';
import { createLogger } from './logger.js';
import type { Logger } from './logger.js';

const parseArg = (flag: string): string | undefined => {
  const idx = process.argv.indexOf(flag);
  const arg = process.argv[idx + 1];
  if (idx < 0 || !arg) return undefined;
  return resolve(arg);
};

const watchConfigForLogLevel = (configDir: string, log: Logger): Disposable => {
  const configPath = join(configDir, 'proxy.config.json');
  let debounce: ReturnType<typeof setTimeout> | undefined;

  const watcher = watch(configPath, () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      void readFile(configPath, 'utf-8').then((text: string) => {
        const parsed = v.safeParse(ProxyConfigSchema, JSON.parse(text));
        if (!parsed.success) return;
        log.setLevel(parsed.output.logLevel);
      }).catch(() => { /* ignore read/parse errors during write */ });
    }, 200);
  });

  return {
    [Symbol.dispose]() {
      clearTimeout(debounce);
      watcher.close();
    },
  };
};

const defaultLogDir = (): string => {
  if (process.platform === 'win32') {
    return join(process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local'), 'lsp-proxy', 'logs');
  }
  return join(process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share'), 'lsp-proxy', 'logs');
};

const main = async (): Promise<void> => {
  const configDir = parseArg('--config-dir');
  const proxyConfig = await loadProxyConfig(configDir);

  // Priority: --log-dir CLI flag > logDir in config > default
  const logDir = parseArg('--log-dir') ?? proxyConfig.logDir ?? defaultLogDir();
  mkdirSync(logDir, { recursive: true });
  // Timestamp + PID: multiple editors may launch proxies in the same second.
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logFile = createWriteStream(join(logDir, `${timestamp}-${String(process.pid)}.log`));
  const log = createLogger(logFile);

  log.setLevel(proxyConfig.logLevel);

  const serverConfigs = new Map(
    await Promise.all(
      proxyConfig.servers.map(async (name): Promise<[string, ServerConfig]> => {
        const config = await loadServerConfig(name, configDir);
        log.info(`Loaded server config: ${name}`);
        return [name, config];
      }),
    ),
  );

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- using: disposed on scope exit
  using _configWatcher = watchConfigForLogLevel(configDir ?? ownPackageDir, log);

  const proxy = new LspProxy(serverConfigs, {
    logger: log,
    watcherExclude: proxyConfig.watcherExclude,
  });
  log.info('Proxy ready — waiting for client');
  await proxy.start();
  process.exit(0);
};

main().catch((err: unknown) => {
  // Logger may not be initialized — write to stderr as fallback
  process.stderr.write(`[lsp-proxy] Fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
