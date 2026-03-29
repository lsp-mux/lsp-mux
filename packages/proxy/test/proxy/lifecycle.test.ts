import { describe } from 'vitest';
import { request, notify, initializeProxy } from '../helpers/test-client.js';
import { faker } from '@faker-js/faker';
import { fakeUri } from '../helpers/fake.js';
import { it } from './harness.js';

const lazyUri = fakeUri();
const testUri = fakeUri();

describe('LspProxy lifecycle', () => {
  describe('lazy initialization', () => {
    it('does not spawn servers during initialize handshake', async ({ createProxy, expect }) => {
      const { writer, reader } = createProxy();

      await initializeProxy(writer, reader);

      const res = await request(writer, reader, 99, 'shutdown');
      expect(res).toMatchObject({ result: null });
    });

    it('starts server on first matching didOpen', async ({ createProxy, expect }) => {
      const { writer, reader } = createProxy();

      await initializeProxy(writer, reader);

      await notify(writer, 'textDocument/didOpen', {
        textDocument: {
          uri: lazyUri,
          languageId: 'typescript',
          version: 1,
          text: faker.lorem.sentence(),
        },
      });

      const hover = await request(writer, reader, 10, 'textDocument/hover', {
        textDocument: { uri: lazyUri },
        position: { line: 0, character: 0 },
      });
      expect(hover).toMatchObject({ result: { echo: 'textDocument/hover' } });
    });
  });

  it('returns ServerNotInitialized for requests before initialize', async ({ createProxy, expect }) => {
    const { writer, reader } = createProxy();

    const res = await request(writer, reader, 1, 'textDocument/hover', {
      textDocument: { uri: testUri },
      position: { line: 0, character: 0 },
    });
    expect(res).toMatchObject({ error: { code: -32002 } });
  });

  it('returns ServerNotInitialized for requests after shutdown', async ({ createProxy, expect }) => {
    const { writer, reader } = createProxy();

    await initializeProxy(writer, reader);

    await request(writer, reader, 98, 'shutdown');

    const res = await request(writer, reader, 99, 'textDocument/hover', {});
    expect(res).toMatchObject({ error: { code: -32002 } });
  });

  it('completes initialize handshake', async ({ createProxy, expect }) => {
    const { writer, reader } = createProxy();

    const res = await initializeProxy(writer, reader);
    expect(res).toMatchObject({ result: { capabilities: { hoverProvider: true } } });
  });

  it('forwards requests to child server', async ({ createProxy, expect }) => {
    const { writer, reader } = createProxy();

    await initializeProxy(writer, reader);

    await notify(writer, 'textDocument/didOpen', {
      textDocument: {
        uri: testUri,
        languageId: 'typescript',
        version: 1,
        text: faker.lorem.sentence(),
      },
    });

    const hover = await request(writer, reader, 10, 'textDocument/hover', {
      textDocument: { uri: testUri },
      position: { line: 0, character: 6 },
    });

    expect(hover).toMatchObject({ result: { echo: 'textDocument/hover' } });
  });

  it('handles shutdown/exit gracefully', async ({ createProxy, expect }) => {
    const { writer, reader } = createProxy();

    await initializeProxy(writer, reader);

    const shutdownRes = await request(writer, reader, 99, 'shutdown');
    expect(shutdownRes).toMatchObject({ result: null });
  });

  it('preserves existing client capabilities when injecting dynamicRegistration', async ({ createProxy, expect }) => {
    const { writer, reader } = createProxy();

    await request(writer, reader, 0, 'initialize', {
      processId: process.pid,
      rootUri: null,
      capabilities: {
        workspace: { applyEdit: true },
        textDocument: { hover: { contentFormat: ['markdown'] } },
      },
    });
    await notify(writer, 'initialized', {});

    const res = await request(writer, reader, 5, '$/initParams');
    expect(res).toMatchObject({
      result: {
        capabilities: {
          workspace: {
            applyEdit: true,
            didChangeWatchedFiles: { dynamicRegistration: true },
          },
          textDocument: { hover: { contentFormat: ['markdown'] } },
        },
      },
    });
  });

  it('injects dynamicRegistration for didChangeWatchedFiles into server init params', async ({ createProxy, expect }) => {
    const { writer, reader } = createProxy();

    await initializeProxy(writer, reader);

    const res = await request(writer, reader, 5, '$/initParams');
    expect(res).toMatchObject({
      result: {
        capabilities: {
          workspace: {
            didChangeWatchedFiles: { dynamicRegistration: true },
          },
        },
      },
    });
  });

  it('always advertises textDocumentSync Full (1) regardless of server capability', async ({ createProxy, expect }) => {
    const { writer, reader } = createProxy();

    // The mock server advertises textDocumentSync: 1, but even if it advertised
    // 2 (Incremental), the proxy must override to 1 (Full) because resync
    // replaces document content, making incremental client edits unsafe.
    const res = await initializeProxy(writer, reader);
    expect(res).toMatchObject({
      result: { capabilities: { textDocumentSync: 1 } },
    });
  });
});
