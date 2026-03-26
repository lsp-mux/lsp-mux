import { describe, it, expect, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import { StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node.js';
import { LspProxy } from '../src/proxy.js';
import type { ServerConfig } from '../src/types.js';
import { request, notify, initializeProxy } from './helpers/test-client.js';

const MOCK_SERVER = join(import.meta.dirname!, 'helpers', 'mock-server.ts');

const mockServerConfig: ServerConfig = {
  command: process.execPath,
  args: ['--import', 'tsx', MOCK_SERVER],
  languages: { typescript: ['.ts'] },
  transport: 'stdio',
};

/** Create an in-process proxy wired to PassThrough streams. */
const createTestProxy = (
  config: ServerConfig = mockServerConfig,
  restartPolicy?: Partial<{ maxRetries: number; baseDelayMs: number; maxDelayMs: number }>,
) => {
  const clientToProxy = new PassThrough();
  const proxyToClient = new PassThrough();

  const proxy = new LspProxy(
    new Map([['mock', config]]),
    {
      input: clientToProxy,
      output: proxyToClient,
      restartPolicy: { maxRetries: 3, baseDelayMs: 50, maxDelayMs: 200, ...restartPolicy },
    },
  );

  const writer = new StreamMessageWriter(clientToProxy);
  const reader = new StreamMessageReader(proxyToClient);

  return { proxy, writer, reader, clientToProxy, proxyToClient };
};

describe('LspProxy integration', () => {
  let proxy: LspProxy;
  let writer: StreamMessageWriter;
  let reader: StreamMessageReader;

  afterEach(() => proxy.dispose());

  it('completes initialize handshake', async () => {
    ({ proxy, writer, reader } = createTestProxy());
    proxy.start();

    const res = await initializeProxy(writer, reader);
    expect(res.result.capabilities.hoverProvider).toBe(true);
  });

  it('forwards requests to child server', async () => {
    ({ proxy, writer, reader } = createTestProxy());
    proxy.start();
    await initializeProxy(writer, reader);

    notify(writer, 'textDocument/didOpen', {
      textDocument: {
        uri: 'file:///test.ts',
        languageId: 'typescript',
        version: 1,
        text: 'const x = 1;',
      },
    });

    const hover = await request(writer, reader, 10, 'textDocument/hover', {
      textDocument: { uri: 'file:///test.ts' },
      position: { line: 0, character: 6 },
    });

    expect(hover.result.echo).toBe('textDocument/hover');
  });

  it('handles shutdown/exit gracefully', async () => {
    ({ proxy, writer, reader } = createTestProxy());
    proxy.start();
    await initializeProxy(writer, reader);

    const shutdownRes = await request(writer, reader, 99, 'shutdown');
    expect(shutdownRes.result).toBeNull();
  });

  describe('restart behavior', () => {
    const crashAndWait = (w: StreamMessageWriter, r: StreamMessageReader, id: number) =>
      request(w, r, id, '$/crash');

    it('restarts after crash and flushes buffered requests', async () => {
      ({ proxy, writer, reader } = createTestProxy());
      proxy.start();
      await initializeProxy(writer, reader);

      const crashRes = await crashAndWait(writer, reader, 19);
      expect(crashRes.error).toBeDefined();

      const hover = await request(writer, reader, 20, 'textDocument/hover', {
        textDocument: { uri: 'file:///test.ts' },
        position: { line: 0, character: 0 },
      });
      expect(hover.result.echo).toBe('textDocument/hover');
    });

    it('replays tracked documents to restarted server', async () => {
      ({ proxy, writer, reader } = createTestProxy());
      proxy.start();
      await initializeProxy(writer, reader);

      notify(writer, 'textDocument/didOpen', {
        textDocument: {
          uri: 'file:///replayed.ts',
          languageId: 'typescript',
          version: 1,
          text: 'const x = 1;',
        },
      });

      const crashRes = await crashAndWait(writer, reader, 25);
      expect(crashRes.error).toBeDefined();

      const docsRes = await request(writer, reader, 26, '$/documents');
      expect(docsRes.result).toEqual([
        { uri: 'file:///replayed.ts', languageId: 'typescript', version: 1 },
      ]);
    });

    it('errors pending requests on crash', async () => {
      ({ proxy, writer, reader } = createTestProxy());
      proxy.start();
      await initializeProxy(writer, reader);

      const res = await crashAndWait(writer, reader, 30);
      expect(res.error).toBeDefined();
      expect(res.error.message).toContain('crashed');
    });

    it('stops if server crashes before initial handshake', async () => {
      const exitingConfig: ServerConfig = {
        command: process.execPath,
        args: ['-e', 'process.exit(1)'],
        languages: { typescript: ['.ts'] },
        transport: 'stdio',
      };
      ({ proxy, writer, reader } = createTestProxy(exitingConfig));
      proxy.start();

      const res = await request(writer, reader, 0, 'initialize', {
        processId: process.pid,
        rootUri: null,
        capabilities: {},
      });
      expect(res.error).toBeDefined();
    });

    it('stops after max retries exhausted', async () => {
      ({ proxy, writer, reader } = createTestProxy(mockServerConfig, { maxRetries: 0 }));
      proxy.start();
      await initializeProxy(writer, reader);

      const crashRes = await crashAndWait(writer, reader, 40);
      expect(crashRes.error).toBeDefined();

      const res = await request(writer, reader, 41, 'textDocument/hover', {
        textDocument: { uri: 'file:///test.ts' },
        position: { line: 0, character: 0 },
      });
      expect(res.error).toBeDefined();
      expect(res.error.code).toBe(-32002); // ServerNotInitialized
    });

    it('handles shutdown during restart', async () => {
      ({ proxy, writer, reader } = createTestProxy(mockServerConfig, {
        baseDelayMs: 500,
      }));
      proxy.start();
      await initializeProxy(writer, reader);

      const crashRes = await crashAndWait(writer, reader, 49);
      expect(crashRes.error).toBeDefined();

      const res = await request(writer, reader, 50, 'shutdown');
      expect(res.result).toBeNull();

      const hover = await request(writer, reader, 51, 'textDocument/hover', {});
      expect(hover.error).toBeDefined();
      expect(hover.error.code).toBe(-32002);
    });

    it('cancels buffered request during restart', async () => {
      ({ proxy, writer, reader } = createTestProxy());
      proxy.start();
      await initializeProxy(writer, reader);

      const crashRes = await crashAndWait(writer, reader, 59);
      expect(crashRes.error).toBeDefined();

      const hoverPromise = request(writer, reader, 60, 'textDocument/hover', {
        textDocument: { uri: 'file:///test.ts' },
        position: { line: 0, character: 0 },
      });
      notify(writer, '$/cancelRequest', { id: 60 });

      const res = await hoverPromise;
      expect(res.error).toBeDefined();
      expect(res.error.code).toBe(-32800); // RequestCancelled
    });
  });
});
