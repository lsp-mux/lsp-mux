import { describe, it } from 'vitest';
import { empty, update, merge, clearServer } from '../src/diagnostics-store.js';

const diagA = { message: 'error from A', severity: 1 };
const diagB = { message: 'warning from B', severity: 2 };
const diagC = { message: 'info from A', severity: 3 };

describe('diagnostics-store', () => {
  describe('empty', () => {
    it('returns empty map', ({ expect }) => {
      expect(empty().size).toBe(0);
    });
  });

  describe('update + merge', () => {
    it('single server, single URI → merge returns those diagnostics', ({ expect }) => {
      const store = update(empty(), 'vtsls', 'file:///a.ts', [diagA]);
      expect(merge(store, 'file:///a.ts')).toEqual([diagA]);
    });

    it('two servers, same URI → merge returns union', ({ expect }) => {
      let store = update(empty(), 'vtsls', 'file:///a.ts', [diagA]);
      store = update(store, 'eslint', 'file:///a.ts', [diagB]);
      expect(merge(store, 'file:///a.ts')).toEqual([diagA, diagB]);
    });

    it('update with empty array removes server entry; merge returns only other server', ({ expect }) => {
      let store = update(empty(), 'vtsls', 'file:///a.ts', [diagA]);
      store = update(store, 'eslint', 'file:///a.ts', [diagB]);
      store = update(store, 'vtsls', 'file:///a.ts', []);
      expect(merge(store, 'file:///a.ts')).toEqual([diagB]);
    });

    it('update with empty array when last server removes URI entirely', ({ expect }) => {
      let store = update(empty(), 'vtsls', 'file:///a.ts', [diagA]);
      store = update(store, 'vtsls', 'file:///a.ts', []);
      expect(store.has('file:///a.ts')).toBe(false);
      expect(merge(store, 'file:///a.ts')).toEqual([]);
    });

    it('merge on unknown URI returns empty array', ({ expect }) => {
      expect(merge(empty(), 'file:///unknown.ts')).toEqual([]);
    });

    it('replaces previous diagnostics for same server + URI', ({ expect }) => {
      let store = update(empty(), 'vtsls', 'file:///a.ts', [diagA]);
      store = update(store, 'vtsls', 'file:///a.ts', [diagC]);
      expect(merge(store, 'file:///a.ts')).toEqual([diagC]);
    });
  });

  describe('clearServer', () => {
    it('returns affected URIs and removes server from all', ({ expect }) => {
      let store = update(empty(), 'vtsls', 'file:///a.ts', [diagA]);
      store = update(store, 'vtsls', 'file:///b.ts', [diagC]);
      store = update(store, 'eslint', 'file:///a.ts', [diagB]);

      const result = clearServer(store, 'vtsls');
      expect(result.affectedUris).toEqual(['file:///a.ts', 'file:///b.ts']);
      // a.ts still has eslint diagnostics
      expect(merge(result.store, 'file:///a.ts')).toEqual([diagB]);
      // b.ts had only vtsls — URI removed entirely
      expect(result.store.has('file:///b.ts')).toBe(false);
    });

    it('is a no-op for server with no entries', ({ expect }) => {
      const store = update(empty(), 'vtsls', 'file:///a.ts', [diagA]);
      const result = clearServer(store, 'eslint');
      expect(result.affectedUris).toEqual([]);
      expect(merge(result.store, 'file:///a.ts')).toEqual([diagA]);
    });
  });

  describe('immutability', () => {
    it('original store unchanged after update', ({ expect }) => {
      const before = empty();
      const after = update(before, 'vtsls', 'file:///a.ts', [diagA]);
      expect(before.size).toBe(0);
      expect(after.size).toBe(1);
    });

    it('original store unchanged after clearServer', ({ expect }) => {
      const before = update(empty(), 'vtsls', 'file:///a.ts', [diagA]);
      const result = clearServer(before, 'vtsls');
      expect(merge(before, 'file:///a.ts')).toEqual([diagA]);
      expect(merge(result.store, 'file:///a.ts')).toEqual([]);
    });
  });
});
