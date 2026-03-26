import * as v from 'valibot';

export const ServerConfigSchema = v.object({
  command: v.pipe(v.string(), v.nonEmpty('command must not be empty')),
  args: v.array(v.string()),
  languages: v.pipe(
    v.record(v.string(), v.array(v.string())),
    v.check(
      (langs) => Object.keys(langs).length > 0,
      'languages must define at least one language',
    ),
  ),
  transport: v.picklist(['stdio']),
  settings: v.optional(v.record(v.string(), v.unknown())),
});

export type ServerConfig = v.InferOutput<typeof ServerConfigSchema>;

export const ProxyConfigSchema = v.object({
  servers: v.pipe(
    v.array(v.pipe(v.string(), v.nonEmpty('server name must not be empty'))),
    v.minLength(1, 'at least one server must be configured'),
  ),
});

export type ProxyConfig = v.InferOutput<typeof ProxyConfigSchema>;
