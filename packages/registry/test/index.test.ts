import { describe, it } from 'vitest';
import { lookupRegistryEntry, listRegistryEntries } from '../src/index.js';

describe('lookupRegistryEntry', () => {
  it('returns entry for known server', async ({ expect }) => {
    const entry = await lookupRegistryEntry('vtsls');
    expect(entry).toBeDefined();
    expect(entry).toHaveProperty('command');
    expect(entry).toHaveProperty('languages');
  });

  it('returns undefined for unknown server', async ({ expect }) => {
    const entry = await lookupRegistryEntry('nonexistent-server-xyz');
    expect(entry).toBeUndefined();
  });

  it('includes npm field in entry', async ({ expect }) => {
    const entry = await lookupRegistryEntry('vtsls');
    expect(entry).toHaveProperty('npm', '@vtsls/language-server');
  });
});

describe('listRegistryEntries', () => {
  it('returns array of server names', async ({ expect }) => {
    const entries = await listRegistryEntries();
    expect(entries).toContain('vtsls');
    expect(entries).toContain('eslint');
  });

  it('returns names without .json extension', async ({ expect }) => {
    const entries = await listRegistryEntries();
    for (const name of entries) {
      expect(name).not.toContain('.json');
    }
  });
});
