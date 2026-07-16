import path from 'node:path';
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
    const count = result.watcherExclude.filter((pattern: string) => pattern === '**/node_modules/**').length;

    expect(count).toBe(1);
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

describe('loadServerConfig', () => {
  it('rejects server names with path traversal', async ({ expect }) => {
    await expect(loadServerConfig('../../../etc/passwd')).rejects.toThrow('Invalid server name');
  });

  it('rejects server names with directory separators', async ({ expect }) => {
    await expect(loadServerConfig('foo/bar')).rejects.toThrow('Invalid server name');
    await expect(loadServerConfig(String.raw`foo\bar`)).rejects.toThrow('Invalid server name');
  });

  it('resolves relative paths and preserves non-path args', async ({ expect }) => {
    const configDir = path.join(import.meta.dirname, 'fixtures');
    const { command, args: [serverBin = '', flagArg = ''] } = await loadServerConfig('relative-paths', configDir);

    expect(path.isAbsolute(command)).toBe(true);
    expect(path.isAbsolute(serverBin)).toBe(true);
    expect(flagArg).toBe('--stdio');
  });
});
