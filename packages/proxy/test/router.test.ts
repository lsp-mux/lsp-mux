import { describe, it } from 'vitest';
import { createRouter, extractUri } from '../src/router.ts';
import type { ServerEntry } from '../src/router.ts';
import type { ServerConfig } from '../src/types.ts';
import { faker } from '@faker-js/faker';
import { fakeUri } from './helpers/fake.ts';

const makeServer = (name: string, languages: Record<string, string[]>): ServerEntry => ({
  name,
  config: { command: name, args: [], languages, transport: 'stdio' } satisfies ServerConfig,
});

const nameA = faker.string.alpha(8);
const nameB = faker.string.alpha(8);
const nameC = faker.string.alpha(8);

const vtsls = makeServer(nameA, {
  typescript: ['.ts', '.tsx'],
  javascript: ['.js', '.jsx'],
});

const eslint = makeServer(nameB, {
  typescript: ['.ts', '.tsx'],
  javascript: ['.js', '.jsx'],
});

const css = makeServer(nameC, {
  css: ['.css'],
  scss: ['.scss'],
});

describe('router', () => {
  describe('single server', () => {
    const router = createRouter([vtsls]);

    it('serversForUri returns the server for a matching URI', ({ expect }) => {
      expect(router.serversForUri(fakeUri('.ts'))).toEqual([nameA]);
    });

    it('primaryForUri returns the server for a matching URI', ({ expect }) => {
      expect(router.primaryForUri(fakeUri('.ts'))).toBe(nameA);
    });
  });

  describe('two servers with overlapping languages', () => {
    const router = createRouter([vtsls, eslint]);

    it('serversForUri returns both in config order', ({ expect }) => {
      expect(router.serversForUri(fakeUri('.tsx'))).toEqual([nameA, nameB]);
    });

    it('primaryForUri returns first', ({ expect }) => {
      expect(router.primaryForUri(fakeUri('.tsx'))).toBe(nameA);
    });
  });

  describe('two servers with different languages', () => {
    const router = createRouter([vtsls, css]);

    it('routes .ts to first server only', ({ expect }) => {
      expect(router.serversForUri(fakeUri('.ts'))).toEqual([nameA]);
    });

    it('routes .css to second server only', ({ expect }) => {
      expect(router.serversForUri(fakeUri('.css'))).toEqual([nameC]);
    });
  });

  describe('unknown extension', () => {
    const router = createRouter([vtsls, css]);

    it('returns allServers as fallback', ({ expect }) => {
      expect(router.serversForUri(fakeUri('.md'))).toEqual([nameA, nameC]);
    });
  });

  describe('undefined URI', () => {
    const router = createRouter([vtsls, css]);

    it('serversForUri returns allServers', ({ expect }) => {
      expect(router.serversForUri(undefined)).toEqual([nameA, nameC]);
    });

    it('primaryForUri returns first of allServers', ({ expect }) => {
      expect(router.primaryForUri(undefined)).toBe(nameA);
    });
  });

  describe('allServers', () => {
    it('returns all names in config order', ({ expect }) => {
      const router = createRouter([css, eslint, vtsls]);
      expect(router.allServers).toEqual([nameC, nameB, nameA]);
    });
  });

  describe('URI edge cases', () => {
    const router = createRouter([vtsls]);

    it('handles URIs with query strings', ({ expect }) => {
      expect(router.serversForUri(`${fakeUri('.ts')}?version=${String(faker.number.int())}`)).toEqual([nameA]);
    });

    it('handles URIs with fragments', ({ expect }) => {
      expect(router.serversForUri(`${fakeUri('.ts')}#L${String(faker.number.int())}`)).toEqual([nameA]);
    });

    it('handles URIs with no extension', ({ expect }) => {
      expect(router.serversForUri(fakeUri(''))).toEqual([nameA]);
    });
  });
});

describe('extractUri', () => {
  it('extracts from params.textDocument.uri', ({ expect }) => {
    const uri = fakeUri();
    const msg = { jsonrpc: '2.0' as const, id: faker.number.int(), method: 'textDocument/hover', params: { textDocument: { uri }, position: { line: 0, character: 0 } } };
    expect(extractUri(msg)).toBe(uri);
  });

  it('extracts from params.uri (e.g. publishDiagnostics)', ({ expect }) => {
    const uri = fakeUri();
    const msg = { jsonrpc: '2.0' as const, method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: [] } };
    expect(extractUri(msg)).toBe(uri);
  });

  it('returns undefined when no URI present', ({ expect }) => {
    const msg = { jsonrpc: '2.0' as const, id: faker.number.int(), method: 'shutdown' };
    expect(extractUri(msg)).toBeUndefined();
  });

  it('returns undefined for response messages', ({ expect }) => {
    const msg = { jsonrpc: '2.0' as const, id: faker.number.int(), result: {} };
    expect(extractUri(msg)).toBeUndefined();
  });

  it('prefers textDocument.uri over params.uri', ({ expect }) => {
    const tdUri = fakeUri();
    const otherUri = fakeUri();
    const msg = { jsonrpc: '2.0' as const, id: faker.number.int(), method: faker.string.alpha(8), params: { textDocument: { uri: tdUri }, uri: otherUri } };
    expect(extractUri(msg)).toBe(tdUri);
  });
});
