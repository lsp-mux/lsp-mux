import { describe, it, expect } from 'vitest';
import { createRouter, extractUri } from '../src/router.js';
import type { ServerEntry } from '../src/router.js';
import type { ServerConfig } from '../src/types.js';

const makeServer = (name: string, languages: Record<string, string[]>): ServerEntry => ({
  name,
  config: { command: name, args: [], languages, transport: 'stdio' } satisfies ServerConfig,
});

const vtsls = makeServer('vtsls', {
  typescript: ['.ts', '.tsx'],
  javascript: ['.js', '.jsx'],
});

const eslint = makeServer('eslint', {
  typescript: ['.ts', '.tsx'],
  javascript: ['.js', '.jsx'],
});

const css = makeServer('css', {
  css: ['.css'],
  scss: ['.scss'],
});

describe('router', () => {
  describe('single server', () => {
    const router = createRouter([vtsls]);

    it('serversForUri returns the server for a matching URI', () => {
      expect(router.serversForUri('file:///project/src/index.ts')).toEqual(['vtsls']);
    });

    it('primaryForUri returns the server for a matching URI', () => {
      expect(router.primaryForUri('file:///project/src/index.ts')).toBe('vtsls');
    });
  });

  describe('two servers with overlapping languages', () => {
    const router = createRouter([vtsls, eslint]);

    it('serversForUri returns both in config order', () => {
      expect(router.serversForUri('file:///project/src/app.tsx')).toEqual(['vtsls', 'eslint']);
    });

    it('primaryForUri returns first', () => {
      expect(router.primaryForUri('file:///project/src/app.tsx')).toBe('vtsls');
    });
  });

  describe('two servers with different languages', () => {
    const router = createRouter([vtsls, css]);

    it('routes .ts to vtsls only', () => {
      expect(router.serversForUri('file:///project/src/main.ts')).toEqual(['vtsls']);
    });

    it('routes .css to css only', () => {
      expect(router.serversForUri('file:///project/src/style.css')).toEqual(['css']);
    });
  });

  describe('unknown extension', () => {
    const router = createRouter([vtsls, css]);

    it('returns allServers as fallback', () => {
      expect(router.serversForUri('file:///project/README.md')).toEqual(['vtsls', 'css']);
    });
  });

  describe('undefined URI', () => {
    const router = createRouter([vtsls, css]);

    it('serversForUri returns allServers', () => {
      expect(router.serversForUri(undefined)).toEqual(['vtsls', 'css']);
    });

    it('primaryForUri returns first of allServers', () => {
      expect(router.primaryForUri(undefined)).toBe('vtsls');
    });
  });

  describe('allServers', () => {
    it('returns all names in config order', () => {
      const router = createRouter([css, eslint, vtsls]);
      expect(router.allServers).toEqual(['css', 'eslint', 'vtsls']);
    });
  });

  describe('URI edge cases', () => {
    const router = createRouter([vtsls]);

    it('handles URIs with query strings', () => {
      expect(router.serversForUri('file:///project/src/foo.ts?version=2')).toEqual(['vtsls']);
    });

    it('handles URIs with fragments', () => {
      expect(router.serversForUri('file:///project/src/foo.ts#L10')).toEqual(['vtsls']);
    });

    it('handles URIs with no extension', () => {
      expect(router.serversForUri('file:///project/Makefile')).toEqual(['vtsls']);
    });
  });
});

describe('extractUri', () => {
  it('extracts from params.textDocument.uri', () => {
    const msg = { jsonrpc: '2.0' as const, id: 1, method: 'textDocument/hover', params: { textDocument: { uri: 'file:///a.ts' }, position: { line: 0, character: 0 } } };
    expect(extractUri(msg)).toBe('file:///a.ts');
  });

  it('extracts from params.uri (e.g. publishDiagnostics)', () => {
    const msg = { jsonrpc: '2.0' as const, method: 'textDocument/publishDiagnostics', params: { uri: 'file:///b.ts', diagnostics: [] } };
    expect(extractUri(msg)).toBe('file:///b.ts');
  });

  it('returns undefined when no URI present', () => {
    const msg = { jsonrpc: '2.0' as const, id: 1, method: 'shutdown' };
    expect(extractUri(msg)).toBeUndefined();
  });

  it('returns undefined for response messages', () => {
    const msg = { jsonrpc: '2.0' as const, id: 1, result: {} };
    expect(extractUri(msg)).toBeUndefined();
  });

  it('prefers textDocument.uri over params.uri', () => {
    const msg = { jsonrpc: '2.0' as const, id: 1, method: 'test', params: { textDocument: { uri: 'file:///td.ts' }, uri: 'file:///other.ts' } };
    expect(extractUri(msg)).toBe('file:///td.ts');
  });
});
