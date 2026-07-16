/** @module-tag slow */
import { faker } from '@faker-js/faker';
import * as v from 'valibot';
import { describe } from 'vitest';
import type { Message } from 'vscode-jsonrpc';
import { fakeUri } from '../helpers/fake.ts';
import { collectMessages, initializeProxy, notify, request } from '../helpers/test-client.ts';
import { type ServerConfig, it, mockServerConfig, namedConfig } from './harness.ts';

const DiagnosticSchema = v.object({ source: v.optional(v.string()) });

const DiagNotificationSchema = v.object({
  params: v.object({
    uri: v.string(),
    diagnostics: v.array(DiagnosticSchema),
  }),
});

const isDiagnosticForUri = (msg: Message | undefined, uri: string): boolean => {
  const result = v.safeParse(DiagNotificationSchema, msg);
  return result.success && result.output.params.uri === uri;
};

const getDiagnostics = (msg: Message | undefined) => {
  const result = v.safeParse(DiagNotificationSchema, msg);
  return result.success ? result.output.params.diagnostics : [];
};

describe('Pull diagnostics', () => {
  it('proactively pulls and publishes diagnostics after didOpen', async ({ createProxy, expect }) => {
    const config: ServerConfig = {
      ...mockServerConfig,
      args: [...mockServerConfig.args, '--pull-diagnostics'],
    };
    const { writer, reader } = createProxy({ config });

    await initializeProxy(writer, reader);

    const uri = fakeUri();
    const diagPromise = collectMessages(
      reader,
      msg => isDiagnosticForUri(msg, uri),
      1,
    );

    await notify(writer, 'textDocument/didOpen', {
      textDocument: { uri, languageId: 'typescript', version: 1, text: faker.lorem.word() },
    });

    // The proxy should proactively pull diagnostics and publish them
    const msgs = await diagPromise;
    const diags = getDiagnostics(msgs[0]);

    expect(diags).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'mock' }),
      ]),
    );
  });

  it('skips proactive pull when client supports pull diagnostics natively', async ({ createProxy, expect }) => {
    const config: ServerConfig = {
      ...mockServerConfig,
      args: [...mockServerConfig.args, '--pull-diagnostics'],
    };
    const { writer, reader } = createProxy({ config });

    // Initialize with pull diagnostic support — proxy should NOT proactively pull
    await request(writer, reader, 0, 'initialize', {
      processId: process.pid,
      /* eslint-disable-next-line unicorn/no-null --
         LSP InitializeParams.rootUri is `string | null`. */
      rootUri: null,
      capabilities: {
        textDocument: {
          diagnostic: { dynamicRegistration: true },
        },
      },
    });
    await notify(writer, 'initialized', {});

    const uri = fakeUri();

    // Wait for the push diagnostic (server always publishes on didOpen).
    // collectMessages owns the reader listener — no concurrent listeners.
    const diagPromise = collectMessages(
      reader,
      msg => isDiagnosticForUri(msg, uri),
      1,
    );

    await notify(writer, 'textDocument/didOpen', {
      textDocument: { uri, languageId: 'typescript', version: 1, text: faker.lorem.word() },
    });

    const pushMsgs = await diagPromise;

    expect(getDiagnostics(pushMsgs[0])).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'mock' }),
      ]),
    );

    // If proactive pull had fired, a second diagnostic publication would arrive
    // shortly after the push one (~100ms). Wait and verify none arrives.
    await expect(
      collectMessages(reader, msg => isDiagnosticForUri(msg, uri), 1, 1000),
    ).rejects.toThrow(/[Tt]imeout/v);
  });

  it('merges pull diagnostics from multiple servers', async ({ createProxy, expect }) => {
    const configs = new Map([
      ['alpha', { ...namedConfig('alpha'), args: [...namedConfig('alpha').args, '--pull-diagnostics'] }],
      ['beta', { ...namedConfig('beta'), args: [...namedConfig('beta').args, '--pull-diagnostics'] }],
    ]);

    const { writer, reader } = createProxy({ configs });

    await initializeProxy(writer, reader);

    const uri = fakeUri();

    await notify(writer, 'textDocument/didOpen', {
      textDocument: { uri, languageId: 'typescript', version: 1, text: faker.lorem.word() },
    });

    // Wait for merged diagnostics containing both servers' pull results
    // plus the push diagnostics from didOpen
    const msgs = await collectMessages(
      reader,
      (msg) => {
        if (!isDiagnosticForUri(msg, uri)) return false;
        const diags = getDiagnostics(msg);
        return diags.some(d => d.source === 'alpha') &&
          diags.some(d => d.source === 'beta');
      },
      1,
    );

    const diags = getDiagnostics(msgs[0]);

    expect(diags).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'alpha' }),
        expect.objectContaining({ source: 'beta' }),
      ]),
    );
  });
});
