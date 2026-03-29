import * as v from 'valibot';
import { describe } from 'vitest';
import type { Message, ResponseMessage } from 'vscode-jsonrpc';
import { Message as Msg, createRequest } from '../src/types.js';
import { collectMessages, request, notify, waitForMessage, initializeProxy } from './helpers/test-client.js';
import { faker } from '@faker-js/faker';
import { fakeUri } from './helpers/fake.js';
import { it, namedConfig } from './proxy/harness.js';

const testUri = fakeUri();
const multiUri = fakeUri();
const fanoutUri = fakeUri();
const crashUri = fakeUri();
const triggerUri = fakeUri();
const fenceUri = fakeUri();

const twoServerConfigs = () => new Map([
  ['alpha', namedConfig('alpha')],
  ['beta', namedConfig('beta')],
]);

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
  it('initializes all servers and merges capabilities', async ({ createProxy, expect }) => {
    const { writer, reader } = createProxy({ configs: twoServerConfigs() });

    const res = await initializeProxy(writer, reader);
    expect(res).toMatchObject({
      result: { capabilities: { hoverProvider: true, textDocumentSync: 1 } },
    });
  });

  it('starts only matching servers for a given file type', async ({ createProxy, expect }) => {
    // Alpha handles .ts, beta handles .css — opening .ts should only start alpha
    const configs = new Map([
      ['alpha', namedConfig('alpha')],
      ['beta', { ...namedConfig('beta'), languages: { css: ['.css'] } }],
    ]);

    const { writer, reader } = createProxy({ configs });
    await initializeProxy(writer, reader);

    // Open a .ts file — only alpha should start
    await notify(writer, 'textDocument/didOpen', {
      textDocument: { uri: testUri, languageId: 'typescript', version: 1, text: faker.lorem.word() },
    });

    // Hover on .ts goes to alpha (primary for .ts)
    const hover = await request(writer, reader, 10, 'textDocument/hover', {
      textDocument: { uri: testUri },
      position: { line: 0, character: 0 },
    });
    expect(hover).toMatchObject({ result: { server: 'alpha' } });

    // Shutdown should succeed instantly — beta was never started
    const shutdownRes = await request(writer, reader, 99, 'shutdown');
    expect(shutdownRes).toMatchObject({ result: null });
  });

  it('merges diagnostics from multiple servers on didOpen', async ({ createProxy, expect }) => {
    const { writer, reader } = createProxy({ configs: twoServerConfigs() });
    await initializeProxy(writer, reader);

    const diagPromise = collectMessages(
      reader,
      msg => isDiagnosticForUri(msg, multiUri),
      2,
    );

    await notify(writer, 'textDocument/didOpen', {
      textDocument: {
        uri: multiUri,
        languageId: 'typescript',
        version: 1,
        text: faker.lorem.sentence(),
      },
    });

    const diagnosticMsgs = await diagPromise;
    expect(getDiagnostics(diagnosticMsgs.at(-1))).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'alpha' }),
      expect.objectContaining({ source: 'beta' }),
    ]));
  });

  it('routes hover request to primary server only', async ({ createProxy, expect }) => {
    const { writer, reader } = createProxy({ configs: twoServerConfigs() });
    await initializeProxy(writer, reader);

    const hover = await request(writer, reader, 10, 'textDocument/hover', {
      textDocument: { uri: testUri },
      position: { line: 0, character: 0 },
    });

    expect(hover).toMatchObject({ result: { echo: 'textDocument/hover', server: 'alpha' } });
  });

  it('fans out didOpen to all matching servers', async ({ createProxy, expect }) => {
    const { writer, reader } = createProxy({ configs: twoServerConfigs() });
    await initializeProxy(writer, reader);

    const diagPromise = collectMessages(
      reader,
      msg => isDiagnosticForUri(msg, fanoutUri),
      2,
    );

    await notify(writer, 'textDocument/didOpen', {
      textDocument: {
        uri: fanoutUri,
        languageId: 'typescript',
        version: 1,
        text: faker.lorem.sentence(),
      },
    });

    const msgs = await diagPromise;
    expect(getDiagnostics(msgs.at(-1))).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'alpha' }),
      expect.objectContaining({ source: 'beta' }),
    ]));
  });

  it('clears crashed server diagnostics and re-publishes', async ({ createProxy, expect }) => {
    const { writer, reader } = createProxy({ configs: twoServerConfigs() });
    await initializeProxy(writer, reader);

    const bothDiags = collectMessages(
      reader,
      msg => isDiagnosticForUri(msg, crashUri),
      2,
    );

    await notify(writer, 'textDocument/didOpen', {
      textDocument: { uri: crashUri, languageId: 'typescript', version: 1, text: faker.lorem.word() },
    });

    await bothDiags;

    await writer.write(createRequest(100, '$/crash', {}));

    const msgs = await collectMessages(
      reader,
      msg =>
        isResponse(msg, 100)
        || (isDiagnosticForUri(msg, crashUri)
          && getDiagnostics(msg).length === 1
          && getDiagnostics(msg)[0]?.source === 'beta'),
      2,
    );

    expect(msgs.find(m => isResponse(m, 100))).toMatchObject({ error: expect.objectContaining({}) as unknown });
    expect(getDiagnostics(msgs.find(m => isDiagnosticForUri(m, crashUri)))).toStrictEqual([
      expect.objectContaining({ source: 'beta' }),
    ]);
  });

  it('handles shutdown with multiple servers', async ({ createProxy, expect }) => {
    const { writer, reader } = createProxy({ configs: twoServerConfigs() });
    await initializeProxy(writer, reader);

    const res = await request(writer, reader, 200, 'shutdown');
    expect(res).toMatchObject({ result: null });
  });

  it('continues operating when one server restarts', async ({ createProxy, expect }) => {
    const { writer, reader } = createProxy({ configs: twoServerConfigs() });
    await initializeProxy(writer, reader);

    const crashRes = await request(writer, reader, 300, '$/crash');
    expect(crashRes).toMatchObject({ error: expect.objectContaining({}) as unknown });

    const hover = await request(writer, reader, 301, 'textDocument/hover', {
      textDocument: { uri: testUri },
      position: { line: 0, character: 0 },
    });

    expect(hover).toMatchObject({ result: { echo: 'textDocument/hover' } });
  });

  it('forces textDocumentSync to Full even when a server advertises Incremental', async ({ createProxy, expect }) => {
    const configs = new Map([
      ['alpha', namedConfig('alpha')],
      ['beta', namedConfig('beta', '--incremental-sync')],
    ]);

    const { writer, reader } = createProxy({ configs });

    const res = await initializeProxy(writer, reader);
    // Even though beta advertises textDocumentSync: 2 (Incremental),
    // the proxy must advertise Full (1) to ensure resync safety.
    expect(res).toMatchObject({
      result: { capabilities: { textDocumentSync: 1 } },
    });
  });

  it('routes client ack to originating server only (not broadcast)', async ({ createProxy, expect }) => {
    const configs = new Map([
      ['alpha', namedConfig('alpha')],
      ['beta', namedConfig('beta', '--register-mixed')],
    ]);

    const { writer, reader } = createProxy({ configs });

    await request(writer, reader, 0, 'initialize', {
      processId: process.pid,
      rootUri: null,
      capabilities: {},
    });
    await notify(writer, 'initialized', {});

    // Listen for the forwarded non-watcher registration before triggering lazy start
    const forwardedPromise = waitForMessage(
      reader,
      msg => Msg.isRequest(msg) && msg.method === 'client/registerCapability',
    );

    // didOpen triggers lazy start of both servers — beta sends registerCapability on initialized
    await notify(writer, 'textDocument/didOpen', {
      textDocument: { uri: triggerUri, languageId: 'typescript', version: 1, text: faker.lorem.word() },
    });

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
      textDocument: { uri: fenceUri },
      position: { line: 0, character: 0 },
    });

    // Alpha (primary, queryable) should NOT have received any response messages
    const alphaResponses = await request(writer, reader, 500, '$/receivedResponses');
    expect(alphaResponses).toMatchObject({ result: [] });
  });
});
