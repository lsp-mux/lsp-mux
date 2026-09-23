/**
 * @module-tag slow
 */
import { describe } from 'vitest';
import { lspErrorCodes } from '../../src/types.ts';
import { fakeUri } from '../helpers/fake.ts';
import { initializeProxy, notify, openDocument, request } from '../helpers/test-client.ts';
import { it } from './harness.ts';

const testUri = fakeUri();

/*
 * The shape the proxy mints for its own requests — `__proxy:<server>:<seq>`,
 * with `mock` the server the harness configures, so the collision is exact
 * rather than merely prefix-shaped.
 */
const internalId = '__proxy:mock:0';

describe('Internal request ID namespace', () => {
  it('rejects a client request wearing an internal ID', async ({ createProxy, expect }) => {
    const { writer, reader } = createProxy();

    await initializeProxy({ writer, reader });

    const res = await request({ writer, reader }, internalId, 'textDocument/hover', {
      textDocument: { uri: testUri },
      position: { line: 0, character: 0 },
    });

    expect(res).toMatchObject({ error: { code: lspErrorCodes.InvalidRequest } });
  });

  it('drops a client cancellation naming an internal ID', async ({ createProxy, expect }) => {
    const { writer, reader } = createProxy();

    await initializeProxy({ writer, reader });
    await openDocument(writer, { uri: testUri });

    await notify(writer, '$/cancelRequest', { id: internalId });
    // Ordinary cancellation behind it, so arrival proves the first was dropped
    await notify(writer, '$/cancelRequest', { id: 7 });

    const res = await request({ writer, reader }, 1, '$/cancellations');

    expect(res).toMatchObject({ result: [{ id: 7 }] });
  });
});
