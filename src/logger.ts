type Level = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const LEVELS: readonly Level[] = ['DEBUG', 'INFO', 'WARN', 'ERROR'];

const minLevel: Level =
  LEVELS.includes(process.env['LOG_LEVEL'] as Level)
    ? process.env['LOG_LEVEL'] as Level
    : 'INFO';

const minIndex = LEVELS.indexOf(minLevel);

const write = (level: Level, ...args: unknown[]): void => {
  if (LEVELS.indexOf(level) < minIndex) return;
  const ts = new Date().toISOString();
  const msg = args
    .map((a) => (a instanceof Error ? (a.stack ?? a.message) : String(a)))
    .join(' ');
  process.stderr.write(`[${ts}] [lsp-proxy] [${level}] ${msg}\n`);
};

export const log = {
  debug: (...args: unknown[]) => write('DEBUG', ...args),
  info: (...args: unknown[]) => write('INFO', ...args),
  warn: (...args: unknown[]) => write('WARN', ...args),
  error: (...args: unknown[]) => write('ERROR', ...args),
};
