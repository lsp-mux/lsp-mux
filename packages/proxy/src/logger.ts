import * as v from 'valibot';

const LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR'] as const;
const levelIndex: Record<string, number> = Object.fromEntries(LEVELS.map((l, i) => [l, i]));
export const LevelSchema = v.picklist(LEVELS);
export type Level = v.InferOutput<typeof LevelSchema>;

export interface Logger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  setLevel: (level: Level | undefined) => void;
}

export const createLogger = (
  output: NodeJS.WritableStream = process.stderr,
  initialLevel: Level = 'INFO',
): Logger => {
  let minIndex = levelIndex[initialLevel] ?? 0;

  const write = (level: Level, ...args: unknown[]): void => {
    if ((levelIndex[level] ?? 0) < minIndex) return;
    const ts = new Date().toISOString();
    const msg = args
      .map(a => (a instanceof Error ? (a.stack ?? a.message) : String(a)))
      .join(' ');
    output.write(`[${ts}] [lsp-proxy] [${level}] ${msg}\n`);
  };

  return {
    debug: (...args: unknown[]) => { write('DEBUG', ...args); },
    info: (...args: unknown[]) => { write('INFO', ...args); },
    warn: (...args: unknown[]) => { write('WARN', ...args); },
    error: (...args: unknown[]) => { write('ERROR', ...args); },
    setLevel: (level: Level | undefined) => {
      const effective = level ?? initialLevel;
      const newIndex = levelIndex[effective] ?? 0;
      if (newIndex === minIndex) return;
      minIndex = newIndex;
      write('INFO', `Log level changed to ${effective}`);
    },
  };
};
