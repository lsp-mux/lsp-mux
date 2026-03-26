import { describe, it, expect, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import { StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node.js';
import { LspProxy } from '../src/proxy.js';
import { createRequest } from '../src/types.js';
import type { ServerConfig } from '../src/types.js';
import { collectMessages, request, notify, initializeProxy } from './helpers/test-client.js';

const MOCK_SERVER = join(import.meta.dirname!, 'helpers', 'mock-server.ts');

const makeConfig = (name: string): ServerConfig => ({
  command: process.execPath,
  args: ['--import', 'tsx', MOCK_SERVER, `--name=${name}`],
  languages: { typescript: ['.ts'] },
  transport: 'stdio',
});

const createMultiProxy = (
  configs: ReadonlyMap<string, ServerConfig>,
  restartPolicy?: Partial<{ maxRetries: number; baseDelayMs: number; maxDelayMs: number }>,
) => {
  const clientToProxy = new PassThrough();
  const proxyToClient = new PassThrough();

  const proxy = new LspProxy(configs, {
    input: clientToProxy,
    output: proxyToClient,
    restartPolicy: { maxRetries: 3, baseDelayMs: 50, maxDelayMs: 200, ...restartPolicy },
  });

  const writer = new StreamMessageWriter(clientToProxy);
  const reader = new StreamMessageReader(proxyToClient);

  return { proxy, writer, reader };
};

const isDiagnosticForUri = (msg: any, uri: string): boolean =>
  msg.method === 'textDocument/publishDiagnostics' && msg.params?.uri === uri;

describe('Multi-server proxy', () => {
  let proxy: LspProxy;
  let writer: StreamMessageWriter;
  let reader: StreamMessageReader;

  afterEach(() => proxy.dispose());

  const twoServerConfigs = () => new Map([
    ['alpha', makeConfig('alpha')],
    ['beta', makeConfig('beta')],
  ]);

  it('initializes all servers and merges capabilities', async () => {
    ({ proxy, writer, reader } = createMultiProxy(twoServerConfigs()));
    proxy.start();

    const res = await initializeProxy(writer, reader);
    expect(res.result.capabilities.hoverProvider).toBe(true);
    expect(res.result.capabilities.textDocumentSync).toBe(1);
  });

  it('merges diagnostics from multiple servers on didOpen', async () => {
    ({ proxy, writer, reader } = createMultiProxy(twoServerConfigs()));
    proxy.start();
    await initializeProxy(writer, reader);

    const diagPromise = collectMessages(
      reader,
      (msg) => isDiagnosticForUri(msg, 'file:///multi.ts'),
      2,
    );

    notify(writer, 'textDocument/didOpen', {
      textDocument: {
        uri: 'file:///multi.ts',
        languageId: 'typescript',
        version: 1,
        text: 'const x = 1;',
      },
    });

    const diagnosticMsgs = await diagPromise;
    const lastDiag = diagnosticMsgs[1];
    const sources = lastDiag.params.diagnostics.map((d: any) => d.source).sort();
    expect(sources).toEqual(['alpha', 'beta']);
  });

  it('routes hover request to primary server only', async () => {
    ({ proxy, writer, reader } = createMultiProxy(twoServerConfigs()));
    proxy.start();
    await initializeProxy(writer, reader);

    const hover = await request(writer, reader, 10, 'textDocument/hover', {
      textDocument: { uri: 'file:///test.ts' },
      position: { line: 0, character: 0 },
    });

    expect(hover.result.echo).toBe('textDocument/hover');
    expect(hover.result.server).toBe('alpha');
  });

  it('fans out didOpen to all matching servers', async () => {
    ({ proxy, writer, reader } = createMultiProxy(twoServerConfigs()));
    proxy.start();
    await initializeProxy(writer, reader);

    const diagPromise = collectMessages(
      reader,
      (msg) => isDiagnosticForUri(msg, 'file:///fanout.ts'),
      2,
    );

    notify(writer, 'textDocument/didOpen', {
      textDocument: {
        uri: 'file:///fanout.ts',
        languageId: 'typescript',
        version: 1,
        text: 'export {};',
      },
    });

    const msgs = await diagPromise;
    const lastMsg = msgs[msgs.length - 1];
    expect(lastMsg.params.diagnostics).toHaveLength(2);
  });

  it('clears crashed server diagnostics and re-publishes', async () => {
    ({ proxy, writer, reader } = createMultiProxy(twoServerConfigs()));
    proxy.start();
    await initializeProxy(writer, reader);

    const uri = 'file:///crash-diag.ts';

    const bothDiags = collectMessages(
      reader,
      (msg) => isDiagnosticForUri(msg, uri),
      2,
    );

    notify(writer, 'textDocument/didOpen', {
      textDocument: { uri, languageId: 'typescript', version: 1, text: 'x' },
    });

    await bothDiags;

    writer.write(createRequest(100, '$/crash', {}));

    const msgs = await collectMessages(
      reader,
      (msg) =>
        (msg.id === 100 && !msg.method) ||
        (isDiagnosticForUri(msg, uri) &&
          msg.params?.diagnostics?.length === 1 &&
          msg.params.diagnostics[0].source === 'beta'),
      2,
    );

    const errorMsg = msgs.find((m: any) => m.id === 100);
    const diagMsg = msgs.find((m: any) => isDiagnosticForUri(m, uri));
    expect(errorMsg.error).toBeDefined();
    expect(diagMsg.params.diagnostics).toHaveLength(1);
    expect(diagMsg.params.diagnostics[0].source).toBe('beta');
  });

  it('handles shutdown with multiple servers', async () => {
    ({ proxy, writer, reader } = createMultiProxy(twoServerConfigs()));
    proxy.start();
    await initializeProxy(writer, reader);

    const res = await request(writer, reader, 200, 'shutdown');
    expect(res.result).toBeNull();
  });

  it('continues operating when one server restarts', async () => {
    ({ proxy, writer, reader } = createMultiProxy(twoServerConfigs()));
    proxy.start();
    await initializeProxy(writer, reader);

    const crashRes = await request(writer, reader, 300, '$/crash');
    expect(crashRes.error).toBeDefined();

    const hover = await request(writer, reader, 301, 'textDocument/hover', {
      textDocument: { uri: 'file:///test.ts' },
      position: { line: 0, character: 0 },
    });

    expect(hover.result.echo).toBe('textDocument/hover');
  });
});
