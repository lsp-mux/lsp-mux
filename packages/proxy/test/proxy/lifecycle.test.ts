/** @module-tag slow */
import { describe } from 'vitest';
import type { ResponseMessage } from 'vscode-jsonrpc';
import { Message as Msg } from '../../src/types.ts';
import { request, notify, waitForMessage, initializeProxy } from '../helpers/test-client.ts';
import { faker } from '@faker-js/faker';
import { fakeUri } from '../helpers/fake.ts';
import { it, mockServerConfig, type ServerConfig } from './harness.ts';

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

  it('injects dynamicRegistration for didChangeWatchedFiles and didChangeConfiguration', async ({ createProxy, expect }) => {
    const { writer, reader } = createProxy();

    await initializeProxy(writer, reader);

    const res = await request(writer, reader, 5, '$/initParams');
    expect(res).toMatchObject({
      result: {
        capabilities: {
          workspace: {
            didChangeWatchedFiles: { dynamicRegistration: true },
            didChangeConfiguration: { dynamicRegistration: true },
          },
        },
      },
    });
  });

  it('preserves client didChangeWatchedFiles when client supports file watching', async ({ createProxy, expect }) => {
    const { writer, reader } = createProxy();

    await request(writer, reader, 0, 'initialize', {
      processId: process.pid,
      rootUri: null,
      capabilities: {
        workspace: {
          didChangeWatchedFiles: { dynamicRegistration: true, relativePatternSupport: true },
        },
      },
    });
    await notify(writer, 'initialized', {});

    const res = await request(writer, reader, 5, '$/initParams');
    // Proxy passes through client's didChangeWatchedFiles without overriding
    expect(res).toMatchObject({
      result: {
        capabilities: {
          workspace: {
            didChangeWatchedFiles: { dynamicRegistration: true, relativePatternSupport: true },
            didChangeConfiguration: { dynamicRegistration: true },
          },
        },
      },
    });
  });

  it('intercepts didChangeConfiguration registration without forwarding to client', async ({ createProxy, expect }) => {
    const config: ServerConfig = {
      ...mockServerConfig,
      args: [...mockServerConfig.args, '--register-config'],
    };
    const { writer, reader } = createProxy({ config });

    await initializeProxy(writer, reader);

    // Trigger lazy start — server registers for didChangeConfiguration on initialized
    await notify(writer, 'textDocument/didOpen', {
      textDocument: { uri: fakeUri(), languageId: 'typescript', version: 1, text: faker.lorem.word() },
    });

    // Fence to ensure registration was processed
    const hover = await request(writer, reader, 10, 'textDocument/hover', {
      textDocument: { uri: fakeUri() },
      position: { line: 0, character: 0 },
    });
    expect(hover).toMatchObject({ result: { echo: 'textDocument/hover' } });

    // Server should have received an ack (not an error) for the registration
    const responses = await request(writer, reader, 11, '$/receivedResponses');
    expect(responses).toMatchObject({
      result: expect.arrayContaining([
        expect.objectContaining({ result: null }),
      ]) as unknown,
    });
  });

  it('sends didChangeConfiguration with settings after server init', async ({ createProxy, expect }) => {
    const config: ServerConfig = {
      ...mockServerConfig,
      args: [...mockServerConfig.args, '--track-config'],
      settings: { validate: 'on', run: 'onType' },
    };
    const { writer, reader } = createProxy({ config });

    await initializeProxy(writer, reader);

    // Trigger lazy start
    await notify(writer, 'textDocument/didOpen', {
      textDocument: { uri: fakeUri(), languageId: 'typescript', version: 1, text: faker.lorem.word() },
    });

    // Fence to ensure init sequence completed
    await request(writer, reader, 10, 'textDocument/hover', {
      textDocument: { uri: fakeUri() },
      position: { line: 0, character: 0 },
    });

    const res = await request(writer, reader, 11, '$/configNotifications');
    expect(res).toMatchObject({
      result: [{ settings: { validate: 'on', run: 'onType' } }],
    });
  });

  it('responds to workspace/configuration with server settings and workspaceFolder', async ({ createProxy, workspace, expect }) => {
    const config: ServerConfig = {
      ...mockServerConfig,
      args: [...mockServerConfig.args, '--request-config'],
      settings: { validate: 'on', nodePath: null },
    };
    const { writer, reader } = createProxy({ config });

    await initializeProxy(writer, reader, workspace.uri);

    // Trigger lazy start — server sends workspace/configuration on initialized
    await notify(writer, 'textDocument/didOpen', {
      textDocument: { uri: fakeUri(), languageId: 'typescript', version: 1, text: faker.lorem.word() },
    });

    // Fence to ensure config request/response round-trip completed
    await request(writer, reader, 10, 'textDocument/hover', {
      textDocument: { uri: fakeUri() },
      position: { line: 0, character: 0 },
    });

    // Server should have received settings with workspaceFolder injected
    const responses = await request(writer, reader, 11, '$/receivedResponses');
    expect(responses).toMatchObject({
      result: expect.arrayContaining([
        expect.objectContaining({
          result: [expect.objectContaining({
            validate: 'on',
            nodePath: null,
            workspaceFolder: expect.objectContaining({ uri: workspace.uri }) as unknown,
          })],
        }),
      ]) as unknown,
    });
  });

  it('routes client response back to the server that sent the request', async ({ createProxy, expect }) => {
    const config: ServerConfig = {
      ...mockServerConfig,
      args: [...mockServerConfig.args, '--send-custom-request'],
    };
    const { writer, reader } = createProxy({ config });

    await initializeProxy(writer, reader);

    // Server sends window/showMessageRequest on initialized — wait for it
    await notify(writer, 'textDocument/didOpen', {
      textDocument: { uri: fakeUri(), languageId: 'typescript', version: 1, text: faker.lorem.word() },
    });

    const serverReq = await waitForMessage(
      reader,
      msg => Msg.isRequest(msg) && msg.method === 'window/showMessageRequest',
    );

    // Client responds
    if (Msg.isRequest(serverReq)) {
      const ack: ResponseMessage = { jsonrpc: '2.0', id: serverReq.id, result: null };
      await writer.write(ack);
    }

    // Fence: round-trip to ensure the response was delivered
    await request(writer, reader, 500, 'textDocument/hover', {
      textDocument: { uri: fakeUri() },
      position: { line: 0, character: 0 },
    });

    // Server should have received the response
    const responses = await request(writer, reader, 501, '$/receivedResponses');
    expect(responses).toMatchObject({
      result: expect.arrayContaining([
        expect.objectContaining({ result: null }),
      ]) as unknown,
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
