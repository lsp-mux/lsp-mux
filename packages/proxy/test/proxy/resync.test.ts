/** @module-tag slow */
import { writeFile } from 'node:fs/promises';
import { describe, vi } from 'vitest';
import { initializeProxy, notify, openDocument, request } from '../helpers/test-client.ts';
import { it } from './harness.ts';

describe('LspProxy file resync', () => {
  it('resyncs document when file changes on disk', async ({ createProxy, workspace, expect }) => {
    const { writer, reader } = createProxy();

    const { path: tmpFile, uri: tmpUri } = workspace.file('resync-test.ts');

    await initializeProxy({ writer, reader }, workspace.uri);

    await writeFile(tmpFile, 'const original = 1;');
    await openDocument(writer, { uri: tmpUri, text: 'const original = 1;' });

    await writeFile(tmpFile, 'const modified = 2;');

    await vi.waitFor(async () => {
      const res = await request({ writer, reader }, workspace.nextSeq(), '$/documents');

      expect(res).toMatchObject({
        result: expect.arrayContaining([
          expect.objectContaining({ uri: tmpUri, text: 'const modified = 2;' }),
        ]) as unknown,
      });
    }, { timeout: 5000, interval: 100 });
  });

  it('maintains monotonically increasing versions after resync', async ({
    createProxy,
    workspace,
    expect,
  }) => {
    const { writer, reader } = createProxy();

    const { path: tmpFile, uri: tmpUri } = workspace.file('resync-test.ts');

    await initializeProxy({ writer, reader }, workspace.uri);

    // Open at version 1 → server sees v1
    await writeFile(tmpFile, 'v1');
    await openDocument(writer, { uri: tmpUri, text: 'v1' });

    // External tool writes → resync bumps to v2
    await writeFile(tmpFile, 'v1-resynced');
    await vi.waitFor(async () => {
      const res = await request({ writer, reader }, workspace.nextSeq(), '$/documents');

      expect(res).toMatchObject({
        result: expect.arrayContaining([
          expect.objectContaining({ uri: tmpUri, text: 'v1-resynced', version: 2 }),
        ]) as unknown,
      });
    }, { timeout: 5000, interval: 100 });

    // Client sends didChange v2 → offset makes server see v3
    await notify(writer, 'textDocument/didChange', {
      textDocument: { uri: tmpUri, version: 2 },
      contentChanges: [{ text: 'v2-from-client' }],
    });

    await vi.waitFor(async () => {
      const res = await request({ writer, reader }, workspace.nextSeq(), '$/documents');

      expect(res).toMatchObject({
        result: expect.arrayContaining([
          expect.objectContaining({ uri: tmpUri, text: 'v2-from-client', version: 3 }),
        ]) as unknown,
      });
    }, { timeout: 5000, interval: 100 });
  });

  it('resets version offset on close and reopen', async ({ createProxy, workspace, expect }) => {
    const { writer, reader } = createProxy();

    const { path: tmpFile, uri: tmpUri } = workspace.file('resync-test.ts');

    await initializeProxy({ writer, reader }, workspace.uri);

    // Open at version 1
    await writeFile(tmpFile, 'original');
    await openDocument(writer, { uri: tmpUri, text: 'original' });

    // External write → resync bumps offset to 1 (server sees v2)
    await writeFile(tmpFile, 'resynced');
    await vi.waitFor(async () => {
      const res = await request({ writer, reader }, workspace.nextSeq(), '$/documents');

      expect(res).toMatchObject({
        result: expect.arrayContaining([
          expect.objectContaining({ uri: tmpUri, version: 2 }),
        ]) as unknown,
      });
    }, { timeout: 5000, interval: 100 });

    // Close the document — should reset offset
    await notify(writer, 'textDocument/didClose', {
      textDocument: { uri: tmpUri },
    });

    // Reopen at version 1 — server should see v1 (offset was cleared)
    await writeFile(tmpFile, 'reopened');
    await openDocument(writer, { uri: tmpUri, text: 'reopened' });

    const res = await request({ writer, reader }, workspace.nextSeq(), '$/documents');

    expect(res).toMatchObject({
      result: expect.arrayContaining([
        expect.objectContaining({ uri: tmpUri, version: 1, text: 'reopened' }),
      ]) as unknown,
    });
  });

  it('server receives correct version after close and reopen post-resync', async ({
    createProxy,
    workspace,
    expect,
  }) => {
    const { writer, reader } = createProxy();

    const { path: tmpFile, uri: tmpUri } = workspace.file('resync-test.ts');

    await initializeProxy({ writer, reader }, workspace.uri);

    // Open at version 1
    await writeFile(tmpFile, 'original');
    await openDocument(writer, { uri: tmpUri, text: 'original' });

    // External write → resync bumps server version to 2 (offset=1)
    await writeFile(tmpFile, 'resynced');
    await vi.waitFor(async () => {
      const res = await request({ writer, reader }, workspace.nextSeq(), '$/documents');

      expect(res).toMatchObject({
        result: expect.arrayContaining([
          expect.objectContaining({ uri: tmpUri, version: 2 }),
        ]) as unknown,
      });
    }, { timeout: 5000, interval: 100 });

    // Close the document — offset should reset
    await notify(writer, 'textDocument/didClose', { textDocument: { uri: tmpUri } });

    // Reopen at version 1 — server should see v1, NOT v2
    await writeFile(tmpFile, 'reopened');
    await openDocument(writer, { uri: tmpUri, text: 'reopened' });

    // Query server directly — it should have version 1 (offset was cleared)
    const res = await request({ writer, reader }, workspace.nextSeq(), '$/documents');

    expect(res).toMatchObject({
      result: expect.arrayContaining([
        expect.objectContaining({ uri: tmpUri, version: 1, text: 'reopened' }),
      ]) as unknown,
    });
  });

  it('multiple resyncs produce monotonically increasing versions', async ({
    createProxy,
    workspace,
    expect,
  }) => {
    const { writer, reader } = createProxy();

    const { path: tmpFile, uri: tmpUri } = workspace.file('resync-test.ts');

    await initializeProxy({ writer, reader }, workspace.uri);

    // Open at version 1 → server sees v1
    await writeFile(tmpFile, 'v1');
    await openDocument(writer, { uri: tmpUri, text: 'v1' });

    // First external write → resync to v2 (offset=1)
    await writeFile(tmpFile, 'disk-v2');
    await vi.waitFor(async () => {
      const res = await request({ writer, reader }, workspace.nextSeq(), '$/documents');

      expect(res).toMatchObject({
        result: expect.arrayContaining([
          expect.objectContaining({ uri: tmpUri, text: 'disk-v2', version: 2 }),
        ]) as unknown,
      });
    }, { timeout: 5000, interval: 100 });

    // Second external write → resync to v3 (offset=2)
    await writeFile(tmpFile, 'disk-v3');
    await vi.waitFor(async () => {
      const res = await request({ writer, reader }, workspace.nextSeq(), '$/documents');

      expect(res).toMatchObject({
        result: expect.arrayContaining([
          expect.objectContaining({ uri: tmpUri, text: 'disk-v3', version: 3 }),
        ]) as unknown,
      });
    }, { timeout: 5000, interval: 100 });

    // Client sends didChange v2 → offset(2) makes server see v4
    await notify(writer, 'textDocument/didChange', {
      textDocument: { uri: tmpUri, version: 2 },
      contentChanges: [{ text: 'client-v4' }],
    });

    await vi.waitFor(async () => {
      const res = await request({ writer, reader }, workspace.nextSeq(), '$/documents');

      expect(res).toMatchObject({
        result: expect.arrayContaining([
          expect.objectContaining({ uri: tmpUri, text: 'client-v4', version: 4 }),
        ]) as unknown,
      });
    }, { timeout: 5000, interval: 100 });
  });

  it('converges to final content after rapid successive writes', async ({
    createProxy,
    workspace,
    expect,
  }) => {
    const { writer, reader } = createProxy();

    const { path: tmpFile, uri: tmpUri } = workspace.file('resync-test.ts');

    await initializeProxy({ writer, reader }, workspace.uri);

    // Open a file
    await writeFile(tmpFile, 'version-0');
    await openDocument(writer, { uri: tmpUri, text: 'version-0' });

    // Rapid successive writes — proxy should converge to the final content
    for (let version = 1; version <= 5; version++) {
      await writeFile(tmpFile, `version-${String(version)}`);
    }

    await vi.waitFor(async () => {
      const res = await request({ writer, reader }, workspace.nextSeq(), '$/documents');

      expect(res).toMatchObject({
        result: expect.arrayContaining([
          expect.objectContaining({ uri: tmpUri, text: 'version-5' }),
        ]) as unknown,
      });
    }, { timeout: 5000, interval: 100 });
  });

  it('skips resync for files exceeding maxResyncBytes', async ({
    createProxy,
    workspace,
    expect,
  }) => {
    const { writer, reader } = createProxy({ maxResyncBytes: 10 });

    const { path: tmpFile, uri: tmpUri } = workspace.file('resync-test.ts');

    await initializeProxy({ writer, reader }, workspace.uri);

    // Open the target file and a small "fence" file
    await writeFile(tmpFile, 'small');
    await openDocument(writer, { uri: tmpUri, text: 'small' });

    const { path: fenceFile, uri: fenceUri } = workspace.file('fence.ts');
    await writeFile(fenceFile, 'original');
    await openDocument(writer, { uri: fenceUri, text: 'original' });

    // External write: target exceeds threshold, fence stays small
    await writeFile(tmpFile, 'x'.repeat(100));
    await writeFile(fenceFile, 'modified');

    // Wait for the fence file to be resynced — this proves the flush completed
    await vi.waitFor(async () => {
      const res = await request({ writer, reader }, workspace.nextSeq(), '$/documents');

      expect(res).toMatchObject({
        result: expect.arrayContaining([
          expect.objectContaining({ uri: fenceUri, text: 'modified' }),
        ]) as unknown,
      });
    }, { timeout: 5000, interval: 100 });

    // The large file should NOT have been resynced
    const res = await request({ writer, reader }, workspace.nextSeq(), '$/documents');

    expect(res).toMatchObject({
      result: expect.arrayContaining([
        expect.objectContaining({ uri: tmpUri, text: 'small' }),
      ]) as unknown,
    });
  });
});
