import * as v from 'valibot';

const LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR'] as const;
const LevelSchema = v.picklist(LEVELS);
type Level = v.InferOutput<typeof LevelSchema>;

const parsed = v.safeParse(LevelSchema, process.env['LOG_LEVEL']);
const minLevel: Level = parsed.success ? parsed.output : 'INFO';

const minIndex = LEVELS.indexOf(minLevel);

const write = (level: Level, ...args: unknown[]): void => {
  if (LEVELS.indexOf(level) < minIndex) return;
  const ts = new Date().toISOString();
  const msg = args
    .map(a => (a instanceof Error ? (a.stack ?? a.message) : String(a)))
    .join(' ');
  process.stderr.write(`[${ts}] [lsp-proxy] [${level}] ${msg}\n`);
};

export const log = {
  debug: (...args: unknown[]) => { write('DEBUG', ...args); },
  info: (...args: unknown[]) => { write('INFO', ...args); },
  warn: (...args: unknown[]) => { write('WARN', ...args); },
  error: (...args: unknown[]) => { write('ERROR', ...args); },
};
