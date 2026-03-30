import * as v from 'valibot';
import { LevelSchema } from './logger.js';

export const ServerConfigSchema = v.object({
  command: v.pipe(v.string(), v.nonEmpty('command must not be empty')),
  args: v.array(v.string()),
  languages: v.pipe(
    v.record(v.string(), v.array(v.string())),
    v.check(
      langs => Object.keys(langs).length > 0,
      'languages must define at least one language',
    ),
  ),
  transport: v.picklist(['stdio']),
  settings: v.optional(v.record(v.string(), v.unknown())),
});

export type ServerConfig = v.InferOutput<typeof ServerConfigSchema>;

const DEFAULT_WATCHER_EXCLUDE = [
  '**/node_modules/**',
  '**/.git/**',
  '**/.hg/**',
  '**/.svn/**',
  '**/dist/**',
];

export const ProxyConfigSchema = v.pipe(
  v.object({
    servers: v.pipe(
      v.array(v.pipe(v.string(), v.nonEmpty('server name must not be empty'))),
      v.minLength(1, 'at least one server must be configured'),
      v.check(
        names => new Set(names).size === names.length,
        'server names must be unique',
      ),
    ),
    watcherExclude: v.optional(v.array(v.string())),
    logLevel: v.optional(LevelSchema),
  }),
  v.transform(cfg => ({
    ...cfg,
    watcherExclude: [...new Set([...DEFAULT_WATCHER_EXCLUDE, ...(cfg.watcherExclude ?? [])])],
  })),
);

export type ProxyConfig = v.InferOutput<typeof ProxyConfigSchema>;
