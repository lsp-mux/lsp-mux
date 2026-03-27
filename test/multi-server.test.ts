import * as v from 'valibot';
import { describe, it, expect, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import type { Message, ResponseMessage } from 'vscode-jsonrpc';
import { StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node.js';
import { LspProxy } from '../src/proxy.js';
import { Message as Msg, createRequest } from '../src/types.js';
import type { ServerConfig } from '../src/types.js';
import { collectMessages, request, notify, waitForMessage, initializeProxy } from './helpers/test-client.js';

const MOCK_SERVER = join(import.meta.dirname, 'helpers', 'mock-server.ts');

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

const DiagNotificationSchema = v.object({
  params: v.object({
    uri: v.string(),
    diagnostics: v.array(v.object({ source: v.optional(v.string()) })),
  }),
});

const parseDiag = (msg: Message | undefined) =>
  v.safeParse(DiagNotificationSchema, msg);

const isDiagnosticForUri = (msg: Message | undefined, uri: string): boolean => {
  const result = parseDiag(msg);
  return result.success && result.output.params.uri === uri;
};

const getDiagnostics = (msg: Message | undefined) => {
  const result = parseDiag(msg);
  return result.success ? result.output.params.diagnostics : [];
};

const isResponse = (msg: Message, id: number): boolean =>
  Msg.isResponse(msg) && msg.id === id;

describe('Multi-server proxy', () => {
  let proxy: LspProxy;
  let writer: StreamMessageWriter;
  let reader: StreamMessageReader;

  afterEach(() => {
    proxy.dispose();
  });

  const twoServerConfigs = () => new Map([
    ['alpha', makeConfig('alpha')],
    ['beta', makeConfig('beta')],
  ]);

  it('initializes all servers and merges capabilities', async () => {
    ({ proxy, writer, reader } = createMultiProxy(twoServerConfigs()));
    void proxy.start();

    const res = await initializeProxy(writer, reader);
    expect(res).toMatchObject({
      result: { capabilities: { hoverProvider: true, textDocumentSync: 1 } },
    });
  });

  it('merges diagnostics from multiple servers on didOpen', async () => {
    ({ proxy, writer, reader } = createMultiProxy(twoServerConfigs()));
    void proxy.start();
    await initializeProxy(writer, reader);

    const diagPromise = collectMessages(
      reader,
      msg => isDiagnosticForUri(msg, 'file:///multi.ts'),
      2,
    );

    await notify(writer, 'textDocument/didOpen', {
      textDocument: {
        uri: 'file:///multi.ts',
        languageId: 'typescript',
        version: 1,
        text: 'const x = 1;',
      },
    });

    const diagnosticMsgs = await diagPromise;
    expect(getDiagnostics(diagnosticMsgs.at(-1))).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'alpha' }),
      expect.objectContaining({ source: 'beta' }),
    ]));
  });

  it('routes hover request to primary server only', async () => {
    ({ proxy, writer, reader } = createMultiProxy(twoServerConfigs()));
    void proxy.start();
    await initializeProxy(writer, reader);

    const hover = await request(writer, reader, 10, 'textDocument/hover', {
      textDocument: { uri: 'file:///test.ts' },
      position: { line: 0, character: 0 },
    });

    expect(hover).toMatchObject({ result: { echo: 'textDocument/hover', server: 'alpha' } });
  });

  it('fans out didOpen to all matching servers', async () => {
    ({ proxy, writer, reader } = createMultiProxy(twoServerConfigs()));
    void proxy.start();
    await initializeProxy(writer, reader);

    const diagPromise = collectMessages(
      reader,
      msg => isDiagnosticForUri(msg, 'file:///fanout.ts'),
      2,
    );

    await notify(writer, 'textDocument/didOpen', {
      textDocument: {
        uri: 'file:///fanout.ts',
        languageId: 'typescript',
        version: 1,
        text: 'export {};',
      },
    });

    const msgs = await diagPromise;
    expect(getDiagnostics(msgs.at(-1))).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'alpha' }),
      expect.objectContaining({ source: 'beta' }),
    ]));
  });

  it('clears crashed server diagnostics and re-publishes', async () => {
    ({ proxy, writer, reader } = createMultiProxy(twoServerConfigs()));
    void proxy.start();
    await initializeProxy(writer, reader);

    const uri = 'file:///crash-diag.ts';

    const bothDiags = collectMessages(
      reader,
      msg => isDiagnosticForUri(msg, uri),
      2,
    );

    await notify(writer, 'textDocument/didOpen', {
      textDocument: { uri, languageId: 'typescript', version: 1, text: 'x' },
    });

    await bothDiags;

    await writer.write(createRequest(100, '$/crash', {}));

    const msgs = await collectMessages(
      reader,
      msg =>
        isResponse(msg, 100)
        || (isDiagnosticForUri(msg, uri)
          && getDiagnostics(msg).length === 1
          && getDiagnostics(msg)[0]?.source === 'beta'),
      2,
    );

    expect(msgs.find(m => isResponse(m, 100))).toMatchObject({ error: expect.objectContaining({}) as unknown });
    expect(getDiagnostics(msgs.find(m => isDiagnosticForUri(m, uri)))).toStrictEqual([
      expect.objectContaining({ source: 'beta' }),
    ]);
  });

  it('handles shutdown with multiple servers', async () => {
    ({ proxy, writer, reader } = createMultiProxy(twoServerConfigs()));
    void proxy.start();
    await initializeProxy(writer, reader);

    const res = await request(writer, reader, 200, 'shutdown');
    expect(res).toMatchObject({ result: null });
  });

  it('continues operating when one server restarts', async () => {
    ({ proxy, writer, reader } = createMultiProxy(twoServerConfigs()));
    void proxy.start();
    await initializeProxy(writer, reader);

    const crashRes = await request(writer, reader, 300, '$/crash');
    expect(crashRes).toMatchObject({ error: expect.objectContaining({}) as unknown });

    const hover = await request(writer, reader, 301, 'textDocument/hover', {
      textDocument: { uri: 'file:///test.ts' },
      position: { line: 0, character: 0 },
    });

    expect(hover).toMatchObject({ result: { echo: 'textDocument/hover' } });
  });

  it('forces textDocumentSync to Full even when a server advertises Incremental', async () => {
    const incrementalConfig: ServerConfig = {
      command: process.execPath,
      args: ['--import', 'tsx', MOCK_SERVER, '--name=beta', '--incremental-sync'],
      languages: { typescript: ['.ts'] },
      transport: 'stdio',
    };
    const configs = new Map([
      ['alpha', makeConfig('alpha')],
      ['beta', incrementalConfig],
    ]);

    ({ proxy, writer, reader } = createMultiProxy(configs));
    void proxy.start();

    const res = await initializeProxy(writer, reader);
    // Even though beta advertises textDocumentSync: 2 (Incremental),
    // the proxy must advertise Full (1) to ensure resync safety.
    expect(res).toMatchObject({
      result: { capabilities: { textDocumentSync: 1 } },
    });
  });

  it('routes client ack to originating server only (not broadcast)', async () => {
    // Beta sends mixed registrations (watcher + non-watcher).
    // Alpha is the primary server and queryable — it should NOT receive
    // the client's ack response for beta's registration.
    const betaConfig: ServerConfig = {
      command: process.execPath,
      args: ['--import', 'tsx', MOCK_SERVER, '--name=beta', '--register-mixed'],
      languages: { typescript: ['.ts'] },
      transport: 'stdio',
    };
    const configs = new Map([
      ['alpha', makeConfig('alpha')],
      ['beta', betaConfig],
    ]);

    ({ proxy, writer, reader } = createMultiProxy(configs));
    void proxy.start();

    await request(writer, reader, 0, 'initialize', {
      processId: process.pid,
      rootUri: null,
      capabilities: {},
    });

    // Listen for the forwarded non-watcher registration before triggering it
    const forwardedPromise = waitForMessage(
      reader,
      msg => Msg.isRequest(msg) && msg.method === 'client/registerCapability',
    );

    await notify(writer, 'initialized', {});

    // Client acks the forwarded registration
    const forwarded = await forwardedPromise;
    if (Msg.isRequest(forwarded)) {
      const ack: ResponseMessage = { jsonrpc: '2.0', id: forwarded.id, result: null };
      await writer.write(ack);
    }

    // Ensure the ack has been fully processed by round-tripping through alpha.
    // Since requests are serialized through the proxy, this guarantees all
    // prior messages (including the ack) have been delivered.
    await request(writer, reader, 499, 'textDocument/hover', {
      textDocument: { uri: 'file:///fence.ts' },
      position: { line: 0, character: 0 },
    });

    // Alpha (primary, queryable) should NOT have received any response messages
    const alphaResponses = await request(writer, reader, 500, '$/receivedResponses');
    expect(alphaResponses).toMatchObject({ result: [] });
  });
});
