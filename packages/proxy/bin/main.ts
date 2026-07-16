import { createWriteStream, mkdirSync, watch } from 'node:fs';
import { readdir, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { milliseconds } from 'date-fns';
import { loadProxyConfig, loadServerConfig, ownPackageDir } from '../src/config.ts';
import { createLogger } from '../src/logger.ts';
import type { Logger } from '../src/logger.ts';
import { LspProxy } from '../src/proxy.ts';
import type { ServerConfig } from '../src/types.ts';

const parseArg = (flag: string): string | undefined => {
  const idx = process.argv.indexOf(flag);
  const arg = process.argv[idx + 1];
  if (idx === -1 || !arg) return undefined;
  return path.resolve(arg);
};

// Debounce window for coalescing rapid config-file writes before reload.
const configWatchDebounceMs = 200;

const watchConfigForLogLevel = (configDir: string, log: Logger): Disposable => {
  let debounce: ReturnType<typeof setTimeout> | undefined;

  const reload = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      void loadProxyConfig(configDir)
        .then((cfg) => { log.setLevel(cfg.logLevel); })
        .catch(() => { /* ignore read/parse errors during write */ });
    }, configWatchDebounceMs);
  };

  const tryWatch = (filePath: string) => {
    try {
      return watch(filePath, reload);
    } catch {
      return undefined;
    }
  };
  const watchers = [
    tryWatch(path.join(configDir, '.lsp-proxy.json')),
    tryWatch(path.join(configDir, '.lsp-proxy.local.json')),
  ];

  return {
    [Symbol.dispose]() {
      clearTimeout(debounce);
      for (const watcher of watchers) watcher?.close();
    },
  };
};

const logMaxAgeMs = milliseconds({ days: 7 });

/**
 * Delete log files older than logMaxAgeMs. Safe for concurrent startup —
 *  ENOENT from a parallel cleanup is silently ignored.
 */
const pruneOldLogs = async (logDir: string): Promise<void> => {
  const now = Date.now();
  let files: string[];
  try {
    files = await readdir(logDir);
  } catch {
    return;
  }
  await Promise.all(
    files
      .filter(fileName => fileName.endsWith('.log'))
      .map(async (fileName) => {
        const filePath = path.join(logDir, fileName);
        try {
          const stats = await stat(filePath);
          if (now - stats.mtimeMs > logMaxAgeMs) await unlink(filePath);
        } catch { /* ENOENT from concurrent cleanup or permission error — ignore */ }
      }),
  );
};

const defaultLogDir = (): string => {
  if (process.platform === 'win32') {
    return path.join(process.env['LOCALAPPDATA'] ?? path.join(homedir(), 'AppData', 'Local'), 'lsp-proxy', 'logs');
  }
  return path.join(process.env['XDG_DATA_HOME'] ?? path.join(homedir(), '.local', 'share'), 'lsp-proxy', 'logs');
};

const main = async (): Promise<void> => {
  const configDir = parseArg('--config-dir');
  const proxyConfig = await loadProxyConfig(configDir);

  // Priority: --log-dir CLI flag > logDir in config > default
  const logDir = parseArg('--log-dir') ?? proxyConfig.logDir ?? defaultLogDir();
  mkdirSync(logDir, { recursive: true });
  void pruneOldLogs(logDir);
  // Timestamp + PID: multiple editors may launch proxies in the same second.
  const timestamp = new Date().toISOString().replaceAll(/[:.]/gv, '-');
  const logFile = createWriteStream(path.join(logDir, `${timestamp}-${String(process.pid)}.log`));
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

try {
  await main();
} catch (error: unknown) {
  // Logger may not be initialized — write to stderr as fallback
  process.stderr.write(`[lsp-proxy] Fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
}
