import { faker } from '@faker-js/faker';
import { describe, it } from 'vitest';
import { empty, toArray, trackOpen } from '../src/document-tracker.ts';
import type { DocumentMap } from '../src/document-tracker.ts';
import { applyToDocuments, resync } from '../src/version-offsets.ts';
import type { VersionOffsets } from '../src/version-offsets.ts';
import { fakeUri } from './helpers/fake.ts';

const uri = fakeUri();
const otherUri = fakeUri();

const openDoc = (docUri: string, text: string, version = 1): DocumentMap =>
  trackOpen(empty(), {
    textDocument: { uri: docUri, languageId: 'typescript', version, text },
  });

const resyncDoc = (offsets: VersionOffsets, text: string) =>
  resync({
    clientVersion: 4,
    documents: openDoc(uri, 'stale'),
    offsets,
    text,
    uri,
  });

describe(resync, () => {
  it('advances the offset a document has not been resynced from', ({ expect }) => {
    expect(resyncDoc(new Map(), 'fresh').offset).toBe(1);
  });

  it('advances the offset past the one the document already carries', ({ expect }) => {
    expect(resyncDoc(new Map([[uri, 6]]), 'fresh').offset).toBe(7);
  });

  it('leaves another document\'s offset out of it', ({ expect }) => {
    expect(resyncDoc(new Map([[otherUri, 6]]), 'fresh').offset).toBe(1);
  });

  it('tracks the new text at the version the client last set', ({ expect }) => {
    const content = faker.lorem.sentence();

    const { documents } = resyncDoc(new Map([[uri, 6]]), content);

    expect(toArray(documents)).toStrictEqual([
      { uri, languageId: 'typescript', version: 4, content },
    ]);
  });

  it('sends the servers the client version plus the new offset', ({ expect }) => {
    const content = faker.lorem.sentence();

    const { notification } = resyncDoc(new Map([[uri, 6]]), content);

    expect(notification).toStrictEqual({
      jsonrpc: '2.0',
      method: 'textDocument/didChange',
      params: {
        textDocument: { uri, version: 11 },
        contentChanges: [{ text: content }],
      },
    });
  });
});

describe(applyToDocuments, () => {
  it('reports a document carrying no offset at the client version', ({ expect }) => {
    const content = faker.lorem.sentence();

    expect(applyToDocuments(openDoc(uri, content, 3), new Map())).toStrictEqual([
      { uri, languageId: 'typescript', version: 3, content },
    ]);
  });

  it('adds the offset a document carries to its version', ({ expect }) => {
    const content = faker.lorem.sentence();

    expect(applyToDocuments(openDoc(uri, content, 3), new Map([[uri, 5]]))).toStrictEqual([
      { uri, languageId: 'typescript', version: 8, content },
    ]);
  });
});
