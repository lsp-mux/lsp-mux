/** @module-tag slow */
import { faker } from '@faker-js/faker';
import { describe } from 'vitest';
import type { StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node.js';
import { fakeUri } from '../helpers/fake.ts';
import { initializeProxy, notify, request } from '../helpers/test-client.ts';
import { type ServerConfig, it } from './harness.ts';

const testUri = fakeUri();
const replayedUri = fakeUri();

const crashAndWait = (w: StreamMessageWriter, r: StreamMessageReader, id: number) =>
  request(w, r, id, '$/crash');

describe('LspProxy restart behavior', () => {
  it('restarts after crash and flushes buffered requests', async ({ createProxy, expect }) => {
    const { writer, reader } = createProxy();

    await initializeProxy(writer, reader);

    const crashRes = await crashAndWait(writer, reader, 19);

    expect(crashRes).toMatchObject({ error: expect.objectContaining({}) as unknown });

    const hover = await request(writer, reader, 20, 'textDocument/hover', {
      textDocument: { uri: testUri },
      position: { line: 0, character: 0 },
    });

    expect(hover).toMatchObject({ result: { echo: 'textDocument/hover' } });
  });

  it('replays tracked documents to restarted server', async ({ createProxy, expect }) => {
    const { writer, reader } = createProxy();

    await initializeProxy(writer, reader);

    await notify(writer, 'textDocument/didOpen', {
      textDocument: {
        uri: replayedUri,
        languageId: 'typescript',
        version: 1,
        text: faker.lorem.sentence(),
      },
    });

    const crashRes = await crashAndWait(writer, reader, 25);

    expect(crashRes).toMatchObject({ error: expect.objectContaining({}) as unknown });

    const docsRes = await request(writer, reader, 26, '$/documents');

    expect(docsRes).toMatchObject({
      result: [{ uri: replayedUri, languageId: 'typescript', version: 1 }],
    });
  });

  it('errors pending requests on crash', async ({ createProxy, expect }) => {
    const { writer, reader } = createProxy();

    await initializeProxy(writer, reader);

    const res = await crashAndWait(writer, reader, 30);

    expect(res).toMatchObject({ error: { message: expect.stringContaining('crashed') as unknown } });
  });

  it('stops if server crashes before initial handshake', async ({ createProxy, expect }) => {
    const exitingConfig: ServerConfig = {
      command: process.execPath,
      args: ['-e', 'process.exit(1)'],
      languages: { typescript: ['.ts'] },
      transport: 'stdio',
    };
    const { writer, reader } = createProxy({ config: exitingConfig });

    await initializeProxy(writer, reader);

    const res = await request(writer, reader, 1, 'textDocument/hover', {
      textDocument: { uri: testUri },
      position: { line: 0, character: 0 },
    });

    expect(res).toMatchObject({ error: expect.objectContaining({}) as unknown });
  });

  it('stops after max retries exhausted', async ({ createProxy, expect }) => {
    const { writer, reader } = createProxy({ restartPolicy: { maxRetries: 0 } });

    await initializeProxy(writer, reader);

    const crashRes = await crashAndWait(writer, reader, 40);

    expect(crashRes).toMatchObject({ error: expect.objectContaining({}) as unknown });

    const res = await request(writer, reader, 41, 'textDocument/hover', {
      textDocument: { uri: testUri },
      position: { line: 0, character: 0 },
    });

    expect(res).toMatchObject({ error: { code: -32_002 } });
  });

  it('resolves start() when all servers exhaust retries', async ({ createProxy, expect }) => {
    const { writer, reader, started } = createProxy({ restartPolicy: { maxRetries: 0 } });
    await initializeProxy(writer, reader);

    // Crash with 0 retries → server enters stopped state → proxy should auto-dispose
    await request(writer, reader, 42, '$/crash');

    // start() should resolve (not hang as a zombie)
    const timeout = new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error('zombie'));
      }, 3000);
    });

    await expect(Promise.race([started, timeout])).resolves.toBeUndefined();
  });

  it('handles shutdown during restart', async ({ createProxy, expect }) => {
    const { writer, reader } = createProxy({
      restartPolicy: { baseDelayMs: 500 },
    });

    await initializeProxy(writer, reader);

    const crashRes = await crashAndWait(writer, reader, 49);

    expect(crashRes).toMatchObject({ error: expect.objectContaining({}) as unknown });

    const res = await request(writer, reader, 50, 'shutdown');

    expect(res).toMatchObject({ result: null });

    const hover = await request(writer, reader, 51, 'textDocument/hover', {});

    expect(hover).toMatchObject({ error: { code: -32_002 } });
  });

  it('cancels buffered request during restart', async ({ createProxy, expect }) => {
    const { writer, reader } = createProxy();

    await initializeProxy(writer, reader);

    const crashRes = await crashAndWait(writer, reader, 59);

    expect(crashRes).toMatchObject({ error: expect.objectContaining({}) as unknown });

    const hoverPromise = request(writer, reader, 60, 'textDocument/hover', {
      textDocument: { uri: testUri },
      position: { line: 0, character: 0 },
    });
    await notify(writer, '$/cancelRequest', { id: 60 });

    const res = await hoverPromise;

    expect(res).toMatchObject({ error: { code: -32_800 } });
  });
});
