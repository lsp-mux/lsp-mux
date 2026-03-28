import { isAbsolute, join } from 'node:path';
import { describe, it } from 'vitest';
import * as v from 'valibot';
import { ProxyConfigSchema, ServerConfigSchema } from '../src/config-schema.js';
import { loadServerConfig } from '../src/config.js';

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
    const count = result.watcherExclude.filter((p: string) => p === '**/node_modules/**').length;
    expect(count).toBe(1);
  });

  it('rejects empty servers array', ({ expect }) => {
    expect(() => v.parse(ProxyConfigSchema, { servers: [] })).toThrow();
  });

  it('rejects empty server name', ({ expect }) => {
    expect(() => v.parse(ProxyConfigSchema, { servers: [''] })).toThrow();
  });

  it('rejects missing servers field', ({ expect }) => {
    expect(() => v.parse(ProxyConfigSchema, {})).toThrow();
  });

  it('rejects duplicate server names', ({ expect }) => {
    expect(() => v.parse(ProxyConfigSchema, { servers: ['vtsls', 'vtsls'] })).toThrow();
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
    expect(() => v.parse(ServerConfigSchema, { ...validConfig, command: '' })).toThrow();
  });

  it('rejects empty languages', ({ expect }) => {
    expect(() => v.parse(ServerConfigSchema, { ...validConfig, languages: {} })).toThrow();
  });

  it('rejects invalid transport', ({ expect }) => {
    expect(() => v.parse(ServerConfigSchema, { ...validConfig, transport: 'tcp' })).toThrow();
  });

  it('accepts optional settings', ({ expect }) => {
    const result = v.parse(ServerConfigSchema, { ...validConfig, settings: { foo: 'bar' } });
    expect(result.settings).toEqual({ foo: 'bar' });
  });
});

describe('loadServerConfig', () => {
  it('rejects server names with path traversal', async ({ expect }) => {
    await expect(loadServerConfig('../../../etc/passwd')).rejects.toThrow();
  });

  it('rejects server names with directory separators', async ({ expect }) => {
    await expect(loadServerConfig('foo/bar')).rejects.toThrow();
    await expect(loadServerConfig('foo\\bar')).rejects.toThrow();
  });

  it('resolves relative paths and preserves non-path args', async ({ expect }) => {
    const configDir = join(import.meta.dirname, 'fixtures');
    const { command, args: [serverBin = '', flagArg = ''] } = await loadServerConfig('relative-paths', configDir);
    expect(isAbsolute(command)).toBe(true);
    expect(isAbsolute(serverBin)).toBe(true);
    expect(flagArg).toBe('--stdio');
  });
});
