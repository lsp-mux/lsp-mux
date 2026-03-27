import { describe, it, expect } from 'vitest';
import * as v from 'valibot';
import { ProxyConfigSchema, ServerConfigSchema } from '../src/config-schema.js';
import { loadServerConfig } from '../src/config.js';

describe('ProxyConfigSchema', () => {
  it('includes default watcher excludes when none specified', () => {
    const result = v.parse(ProxyConfigSchema, { servers: ['vtsls'] });
    expect(result.watcherExclude).toContain('**/node_modules/**');
    expect(result.watcherExclude).toContain('**/.git/**');
  });

  it('merges user watcherExclude with defaults', () => {
    const result = v.parse(ProxyConfigSchema, {
      servers: ['vtsls'],
      watcherExclude: ['**/build/**'],
    });
    expect(result.watcherExclude).toContain('**/build/**');
    expect(result.watcherExclude).toContain('**/node_modules/**');
    expect(result.watcherExclude).toContain('**/.git/**');
  });

  it('deduplicates watcherExclude when user repeats a default', () => {
    const result = v.parse(ProxyConfigSchema, {
      servers: ['vtsls'],
      watcherExclude: ['**/node_modules/**'],
    });
    const count = result.watcherExclude.filter((p: string) => p === '**/node_modules/**').length;
    expect(count).toBe(1);
  });

  it('rejects empty servers array', () => {
    expect(() => v.parse(ProxyConfigSchema, { servers: [] })).toThrow();
  });

  it('rejects empty server name', () => {
    expect(() => v.parse(ProxyConfigSchema, { servers: [''] })).toThrow();
  });

  it('rejects missing servers field', () => {
    expect(() => v.parse(ProxyConfigSchema, {})).toThrow();
  });

  it('rejects duplicate server names', () => {
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

  it('accepts valid config', () => {
    expect(() => v.parse(ServerConfigSchema, validConfig)).not.toThrow();
  });

  it('rejects empty command', () => {
    expect(() => v.parse(ServerConfigSchema, { ...validConfig, command: '' })).toThrow();
  });

  it('rejects empty languages', () => {
    expect(() => v.parse(ServerConfigSchema, { ...validConfig, languages: {} })).toThrow();
  });

  it('rejects invalid transport', () => {
    expect(() => v.parse(ServerConfigSchema, { ...validConfig, transport: 'tcp' })).toThrow();
  });

  it('accepts optional settings', () => {
    const result = v.parse(ServerConfigSchema, { ...validConfig, settings: { foo: 'bar' } });
    expect(result.settings).toEqual({ foo: 'bar' });
  });
});

describe('loadServerConfig', () => {
  it('rejects server names with path traversal', async () => {
    await expect(loadServerConfig('../../../etc/passwd')).rejects.toThrow();
  });

  it('rejects server names with directory separators', async () => {
    await expect(loadServerConfig('foo/bar')).rejects.toThrow();
    await expect(loadServerConfig('foo\\bar')).rejects.toThrow();
  });
});
