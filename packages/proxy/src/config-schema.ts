import * as v from 'valibot';
import { LevelSchema } from './logger.ts';

const StringArraySchema = v.array(v.string());

const NotificationLogLevelSchema = v.pipe(
  LevelSchema,
  v.transform((level): 'debug' | 'info' | 'warn' | 'error' => {
    const map = { DEBUG: 'debug', INFO: 'info', WARN: 'warn', ERROR: 'error' } as const;
    return map[level];
  }),
);

const NotificationConfigSchema = v.object({
  logLevel: NotificationLogLevelSchema,
});

const CommandSchema = v.pipe(v.string(), v.nonEmpty('command must not be empty'));

const LanguagesSchema = v.pipe(
  v.record(v.string(), StringArraySchema),
  v.check(
    langs => Object.keys(langs).length > 0,
    'languages must define at least one language',
  ),
);

const SettingsSchema = v.record(v.string(), v.unknown());

const NotificationsSchema = v.record(v.string(), NotificationConfigSchema);

export const ServerConfigSchema = v.object({
  command: CommandSchema,
  args: StringArraySchema,
  languages: LanguagesSchema,
  transport: v.picklist(['stdio']),
  settings: v.optional(SettingsSchema),
  notifications: v.optional(NotificationsSchema),
});

export type ServerConfig = v.InferOutput<typeof ServerConfigSchema>;

const defaultWatcherExclude = [
  '**/node_modules/**',
  '**/.git/**',
  '**/.hg/**',
  '**/.svn/**',
  '**/dist/**',
];

const ServerNameSchema = v.pipe(v.string(), v.nonEmpty('server name must not be empty'));

const ServersSchema = v.pipe(
  v.array(ServerNameSchema),
  v.minLength(1, 'at least one server must be configured'),
  v.check(
    names => new Set(names).size === names.length,
    'server names must be unique',
  ),
);

const LogDirSchema = v.optional(v.string());

/*
 * A bridge forwards a notification one server sends to its editor into a
 * request on another server, and the answer back. The wire details belong to
 * the protocol rather than to the operator, so `protocol` selects them and
 * only the endpoints are configurable.
 */
const BridgeSchema = v.object({
  protocol: v.picklist(['tsserver']),
  from: ServerNameSchema,
  to: ServerNameSchema,
});

export type BridgeConfig = v.InferOutput<typeof BridgeSchema>;

const BridgesSchema = v.array(BridgeSchema);

export const ProxyConfigSchema = v.pipe(
  v.object({
    servers: ServersSchema,
    bridges: v.optional(BridgesSchema),
    watcherExclude: v.optional(StringArraySchema),
    logLevel: v.optional(LevelSchema),
    logDir: LogDirSchema,
  }),
  v.check(
    cfg => (cfg.bridges ?? []).every(
      bridge => cfg.servers.includes(bridge.from) && cfg.servers.includes(bridge.to),
    ),
    'bridge endpoints must be configured servers',
  ),
  v.check(
    cfg => (cfg.bridges ?? []).every(bridge => bridge.from !== bridge.to),
    'bridge endpoints must differ',
  ),
  /*
   * The router answers a server's notifications from one target, so a second
   * bridge out of the same server would silently replace the first rather
   * than run beside it.
   */
  v.check(
    (cfg) => {
      const sources = (cfg.bridges ?? []).map(bridge => bridge.from);
      return new Set(sources).size === sources.length;
    },
    'bridge sources must be unique',
  ),
  v.transform(cfg => ({
    ...cfg,
    bridges: cfg.bridges ?? [],
    watcherExclude: [...new Set([...defaultWatcherExclude, ...(cfg.watcherExclude ?? [])])],
  })),
);

export type ProxyConfig = v.InferOutput<typeof ProxyConfigSchema>;
