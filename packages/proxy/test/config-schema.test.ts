import path from 'node:path';
import {
  listRegistryEntries,
  lookupRegistryEntry,
  serverConfigFromEntry,
} from 'lsp-proxy-registry';
import * as v from 'valibot';
import { describe, it } from 'vitest';
import { ProxyConfigSchema, ServerConfigSchema } from '../src/config-schema.ts';
import { loadServerConfig } from '../src/config.ts';

describe('ProxyConfigSchema', () => {
  it('includes default watcher excludes when none specified', ({ expect }) => {
    const result = v.parse(ProxyConfigSchema, { servers: ['vtsls'] });

    expect(result.watcherExclude).toContain('**/node_modules/**');
    expect(result.watcherExclude).toContain('**/.git/**');
  });

  it('merges user watcherExclude with defaults', ({ expect }) => {
    const result = v.parse(ProxyConfigSchema, {
      servers: ['vtsls'],
      watcherExclude: ['**/build/**'],
    });

    expect(result.watcherExclude).toContain('**/build/**');
    expect(result.watcherExclude).toContain('**/node_modules/**');
    expect(result.watcherExclude).toContain('**/.git/**');
  });

  it('deduplicates watcherExclude when user repeats a default', ({ expect }) => {
    const result = v.parse(ProxyConfigSchema, {
      servers: ['vtsls'],
      watcherExclude: ['**/node_modules/**'],
    });
    const matches = result.watcherExclude.filter(
      (pattern: string) => pattern === '**/node_modules/**',
    );

    expect(matches).toHaveLength(1);
  });

  it('rejects empty servers array', ({ expect }) => {
    expect(() => v.parse(ProxyConfigSchema, { servers: [] }))
      .toThrow('at least one server must be configured');
  });

  it('rejects empty server name', ({ expect }) => {
    expect(() => v.parse(ProxyConfigSchema, { servers: [''] }))
      .toThrow('server name must not be empty');
  });

  it('rejects missing servers field', ({ expect }) => {
    expect(() => v.parse(ProxyConfigSchema, {})).toThrow('Invalid key: Expected "servers"');
  });

  it('rejects duplicate server names', ({ expect }) => {
    expect(() => v.parse(ProxyConfigSchema, { servers: ['vtsls', 'vtsls'] }))
      .toThrow('server names must be unique');
  });

  it('accepts valid logLevel', ({ expect }) => {
    const result = v.parse(ProxyConfigSchema, { servers: ['vtsls'], logLevel: 'DEBUG' });

    expect(result.logLevel).toBe('DEBUG');
  });

  it('defaults logLevel to undefined when omitted', ({ expect }) => {
    const result = v.parse(ProxyConfigSchema, { servers: ['vtsls'] });

    expect(result.logLevel).toBeUndefined();
  });

  it('rejects invalid logLevel', ({ expect }) => {
    expect(() => v.parse(ProxyConfigSchema, { servers: ['vtsls'], logLevel: 'TRACE' }))
      .toThrow('"DEBUG" | "INFO" | "WARN" | "ERROR"');
  });

  it('accepts valid logDir', ({ expect }) => {
    const result = v.parse(ProxyConfigSchema, { servers: ['vtsls'], logDir: '/tmp/logs' });

    expect(result.logDir).toBe('/tmp/logs');
  });

  it('defaults logDir to undefined when omitted', ({ expect }) => {
    const result = v.parse(ProxyConfigSchema, { servers: ['vtsls'] });

    expect(result.logDir).toBeUndefined();
  });

  it('defaults bridges to empty when omitted', ({ expect }) => {
    const result = v.parse(ProxyConfigSchema, { servers: ['vtsls'] });

    expect(result.bridges).toStrictEqual([]);
  });

  it('accepts a tsserver bridge between configured servers', ({ expect }) => {
    const result = v.parse(ProxyConfigSchema, {
      servers: ['vue', 'vtsls'],
      bridges: [{ protocol: 'tsserver', from: 'vue', to: 'vtsls' }],
    });

    expect(result.bridges).toStrictEqual([
      { protocol: 'tsserver', from: 'vue', to: 'vtsls' },
    ]);
  });

  it('rejects an unknown bridge protocol', ({ expect }) => {
    expect(() => v.parse(ProxyConfigSchema, {
      servers: ['vue', 'vtsls'],
      bridges: [{ protocol: 'named-pipe', from: 'vue', to: 'vtsls' }],
    })).toThrow('Expected "tsserver"');
  });

  it('rejects a bridge whose source is not a configured server', ({ expect }) => {
    expect(() => v.parse(ProxyConfigSchema, {
      servers: ['vtsls'],
      bridges: [{ protocol: 'tsserver', from: 'vue', to: 'vtsls' }],
    })).toThrow('bridge endpoints must be configured servers');
  });

  it('rejects a bridge whose target is not a configured server', ({ expect }) => {
    expect(() => v.parse(ProxyConfigSchema, {
      servers: ['vue'],
      bridges: [{ protocol: 'tsserver', from: 'vue', to: 'vtsls' }],
    })).toThrow('bridge endpoints must be configured servers');
  });

  it('rejects two bridges from the same source server', ({ expect }) => {
    expect(() => v.parse(ProxyConfigSchema, {
      servers: ['vue', 'vtsls', 'other'],
      bridges: [
        { protocol: 'tsserver', from: 'vue', to: 'vtsls' },
        { protocol: 'tsserver', from: 'vue', to: 'other' },
      ],
    })).toThrow('bridge sources must be unique');
  });

  it('rejects a bridge pointing a server at itself', ({ expect }) => {
    expect(() => v.parse(ProxyConfigSchema, {
      servers: ['vtsls'],
      bridges: [{ protocol: 'tsserver', from: 'vtsls', to: 'vtsls' }],
    })).toThrow('bridge endpoints must differ');
  });
});

describe('ServerConfigSchema', () => {
  const validConfig = {
    command: 'node',
    args: ['--inspect'],
    languages: { typescript: ['.ts'] },
    transport: 'stdio',
  };

  it('accepts valid config', ({ expect }) => {
    expect(() => v.parse(ServerConfigSchema, validConfig)).not.toThrow();
  });

  it('rejects empty command', ({ expect }) => {
    expect(() => v.parse(ServerConfigSchema, { ...validConfig, command: '' }))
      .toThrow('command must not be empty');
  });

  it('rejects empty languages', ({ expect }) => {
    expect(() => v.parse(ServerConfigSchema, { ...validConfig, languages: {} }))
      .toThrow('languages must define at least one language');
  });

  it('rejects invalid transport', ({ expect }) => {
    expect(() => v.parse(ServerConfigSchema, { ...validConfig, transport: 'tcp' }))
      .toThrow('Expected "stdio"');
  });

  it('accepts optional settings', ({ expect }) => {
    const result = v.parse(ServerConfigSchema, { ...validConfig, settings: { foo: 'bar' } });

    expect(result.settings).toStrictEqual({ foo: 'bar' });
  });
});

describe('registry entries', () => {
  /*
   * The registry ships these as plain JSON, and nothing validates them until
   * a user names one and the proxy tries to launch it. Parse every entry
   * here so a malformed one fails the build rather than somebody's editor.
   */
  it('every entry parses as a server config', ({ expect }) => {
    const names = listRegistryEntries();
    const invalid = names.filter(name => !v.safeParse(
      ServerConfigSchema,
      serverConfigFromEntry(lookupRegistryEntry(name) ?? {}),
    ).success);

    expect(names.length).toBeGreaterThan(0);
    expect(invalid).toStrictEqual([]);
  });

  it('routes .vue files to the vue server', ({ expect }) => {
    const entry = lookupRegistryEntry('vue');
    const config = v.parse(ServerConfigSchema, serverConfigFromEntry(entry ?? {}));

    expect(config.languages).toStrictEqual({ vue: ['.vue'] });
    expect(entry).toHaveProperty('npm', '@vue/language-server');
  });
});

const PluginEntrySchema = v.object({ location: v.string(), name: v.string() });

const PluginSettingsSchema = v.object({
  maxMemory: v.number(),
  nodePath: v.null(),
  tsserver: v.object({ globalPlugins: v.array(PluginEntrySchema) }),
  useESLintClass: v.boolean(),
  validate: v.string(),
});

describe('loadServerConfig', () => {
  it('rejects server names with path traversal', async ({ expect }) => {
    await expect(loadServerConfig('../../../etc/passwd')).rejects.toThrow('Invalid server name');
  });

  it('rejects server names with directory separators', async ({ expect }) => {
    await expect(loadServerConfig('foo/bar')).rejects.toThrow('Invalid server name');
    await expect(loadServerConfig(String.raw`foo\bar`)).rejects.toThrow('Invalid server name');
  });

  it('resolves a relative path nested in settings', async ({ expect }) => {
    const configDir = path.join(import.meta.dirname, 'fixtures');
    const { settings } = await loadServerConfig('relative-paths', configDir);
    const parsed = v.parse(PluginSettingsSchema, settings);
    const [plugin] = parsed.tsserver.globalPlugins;

    /* A server that takes a path through its settings — vtsls locating a
       tsserver plugin, say — can only be given one the config dir resolves. */
    expect(path.isAbsolute(plugin?.location ?? '')).toBe(true);
    expect(plugin?.location).toBe(path.join(configDir, 'node_modules', 'some-plugin'));
    expect(plugin?.name).toBe('some-plugin');
    expect(parsed.validate).toBe('on');
  });

  it('leaves settings that are not relative paths alone', async ({ expect }) => {
    const configDir = path.join(import.meta.dirname, 'fixtures');
    const { settings } = await loadServerConfig('relative-paths', configDir);
    const parsed = v.parse(PluginSettingsSchema, settings);

    /*
     * The walk reaches every value, so anything it does not recognise as a
     * relative path has to come back out identical — a number, a boolean and
     * a null among them, all of which real server settings carry.
     */
    expect(parsed.maxMemory).toBe(3072);
    expect(parsed.useESLintClass).toBe(true);
    expect(parsed.nodePath).toBeNull();
  });

  it('resolves relative paths and preserves non-path args', async ({ expect }) => {
    const configDir = path.join(import.meta.dirname, 'fixtures');
    const { command, args } = await loadServerConfig('relative-paths', configDir);
    const [serverBin = '', flagArg = ''] = args;

    expect(path.isAbsolute(command)).toBe(true);
    expect(path.isAbsolute(serverBin)).toBe(true);
    expect(flagArg).toBe('--stdio');
  });
});
