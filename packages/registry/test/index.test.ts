import { describe, it } from 'vitest';
import { lookupRegistryEntry, listRegistryEntries } from '../src/index.ts';

describe('lookupRegistryEntry', () => {
  it('returns entry for known server', ({ expect }) => {
    const entry = lookupRegistryEntry('vtsls');
    expect(entry).toBeDefined();
    expect(entry).toHaveProperty('command');
    expect(entry).toHaveProperty('languages');
  });

  it('returns undefined for unknown server', ({ expect }) => {
    const entry = lookupRegistryEntry('nonexistent-server-xyz');
    expect(entry).toBeUndefined();
  });

  it('includes npm field in entry', ({ expect }) => {
    const entry = lookupRegistryEntry('vtsls');
    expect(entry).toHaveProperty('npm', '@vtsls/language-server');
  });
});

describe('listRegistryEntries', () => {
  it('returns array of server names', ({ expect }) => {
    const entries = listRegistryEntries();
    expect(entries).toContain('vtsls');
    expect(entries).toContain('eslint');
  });

  it('returns names without .json extension', ({ expect }) => {
    const entries = listRegistryEntries();
    for (const name of entries) {
      expect(name).not.toContain('.json');
    }
  });
});
