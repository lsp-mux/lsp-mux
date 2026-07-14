import { faker } from '@faker-js/faker';
import { describe, it } from 'vitest';
import { clearServer, empty, merge, update } from '../src/diagnostics-store.ts';
import { fakeUri } from './helpers/fake.ts';

const serverA = faker.string.alpha(8);
const serverB = faker.string.alpha(8);
const uriA = fakeUri();
const uriB = fakeUri();

const diagA = { message: faker.lorem.words(2), severity: 1 };
const diagB = { message: faker.lorem.words(2), severity: 2 };
const diagC = { message: faker.lorem.words(2), severity: 3 };

describe('diagnostics-store', () => {
  describe('empty', () => {
    it('returns empty map', ({ expect }) => {
      expect(empty().size).toBe(0);
    });
  });

  describe('update + merge', () => {
    it('single server, single URI → merge returns those diagnostics', ({ expect }) => {
      const store = update(empty(), serverA, uriA, [diagA]);

      expect(merge(store, uriA)).toStrictEqual([diagA]);
    });

    it('two servers, same URI → merge returns union', ({ expect }) => {
      let store = update(empty(), serverA, uriA, [diagA]);
      store = update(store, serverB, uriA, [diagB]);

      expect(merge(store, uriA)).toStrictEqual([diagA, diagB]);
    });

    it('update with empty array removes server entry; merge returns only other server', ({ expect }) => {
      let store = update(empty(), serverA, uriA, [diagA]);
      store = update(store, serverB, uriA, [diagB]);
      store = update(store, serverA, uriA, []);

      expect(merge(store, uriA)).toStrictEqual([diagB]);
    });

    it('update with empty array when last server removes URI entirely', ({ expect }) => {
      let store = update(empty(), serverA, uriA, [diagA]);
      store = update(store, serverA, uriA, []);

      expect(store.has(uriA)).toBe(false);
      expect(merge(store, uriA)).toStrictEqual([]);
    });

    it('merge on unknown URI returns empty array', ({ expect }) => {
      expect(merge(empty(), fakeUri())).toStrictEqual([]);
    });

    it('replaces previous diagnostics for same server + URI', ({ expect }) => {
      let store = update(empty(), serverA, uriA, [diagA]);
      store = update(store, serverA, uriA, [diagC]);

      expect(merge(store, uriA)).toStrictEqual([diagC]);
    });
  });

  describe('clearServer', () => {
    it('returns affected URIs and removes server from all', ({ expect }) => {
      let store = update(empty(), serverA, uriA, [diagA]);
      store = update(store, serverA, uriB, [diagC]);
      store = update(store, serverB, uriA, [diagB]);

      const result = clearServer(store, serverA);

      expect(result.affectedUris).toStrictEqual([uriA, uriB]);
      // uriA still has serverB diagnostics
      expect(merge(result.store, uriA)).toStrictEqual([diagB]);
      // uriB had only serverA — URI removed entirely
      expect(result.store.has(uriB)).toBe(false);
    });

    it('is a no-op for server with no entries', ({ expect }) => {
      const store = update(empty(), serverA, uriA, [diagA]);
      const result = clearServer(store, serverB);

      expect(result.affectedUris).toStrictEqual([]);
      expect(merge(result.store, uriA)).toStrictEqual([diagA]);
    });
  });

  describe('immutability', () => {
    it('original store unchanged after update', ({ expect }) => {
      const before = empty();
      const after = update(before, serverA, uriA, [diagA]);

      expect(before.size).toBe(0);
      expect(after.size).toBe(1);
    });

    it('original store unchanged after clearServer', ({ expect }) => {
      const before = update(empty(), serverA, uriA, [diagA]);
      const result = clearServer(before, serverA);

      expect(merge(before, uriA)).toStrictEqual([diagA]);
      expect(merge(result.store, uriA)).toStrictEqual([]);
    });
  });
});
