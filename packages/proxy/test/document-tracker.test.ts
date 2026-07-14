import { faker } from '@faker-js/faker';
import { describe, it } from 'vitest';
import { empty, toArray, trackChange, trackClose, trackOpen } from '../src/document-tracker.ts';
import type { DocumentMap } from '../src/document-tracker.ts';
import type { TrackedDocument } from '../src/types.ts';
import { fakeUri } from './helpers/fake.ts';

const uri = fakeUri();
const uriA = fakeUri();
const uriB = fakeUri();

const openDoc = (docUri: string, text: string, version = 1) =>
  trackOpen(empty(), {
    textDocument: { uri: docUri, languageId: 'typescript', version, text },
  });

/** Get first document or fail — avoids `noUncheckedIndexedAccess` noise in tests. */
const first = (docs: DocumentMap): TrackedDocument => {
  const doc = toArray(docs)[0];
  if (!doc) throw new Error('Expected document');
  return doc;
};

describe('document-tracker', () => {
  describe('trackOpen', () => {
    it('stores document state', ({ expect }) => {
      const content = faker.lorem.sentence();
      const docs = openDoc(uri, content);

      expect(toArray(docs)).toStrictEqual([
        { uri, languageId: 'typescript', version: 1, content },
      ]);
    });

    it('overwrites existing document at same URI', ({ expect }) => {
      const newContent = faker.lorem.sentence();
      let docs = openDoc(uriA, faker.lorem.sentence());
      docs = trackOpen(docs, {
        textDocument: { uri: uriA, languageId: 'typescript', version: 2, text: newContent },
      });

      expect(toArray(docs)).toStrictEqual([expect.objectContaining({ content: newContent })]);
    });
  });

  describe('trackChange — full replacement', () => {
    it('replaces entire content', ({ expect }) => {
      const newContent = faker.lorem.sentence();
      let docs = openDoc(uri, faker.lorem.sentence());
      docs = trackChange(docs, {
        textDocument: { uri, version: 2 },
        contentChanges: [{ text: newContent }],
      });

      expect(first(docs)).toMatchObject({ content: newContent, version: 2 });
    });
  });

  describe('trackChange — incremental', () => {
    // Incremental edit tests keep specific content — positions are mathematically coupled

    it('inserts text at a position', ({ expect }) => {
      let docs = openDoc(uri, 'hello world');
      docs = trackChange(docs, {
        textDocument: { uri, version: 2 },
        contentChanges: [
          {
            text: 'beautiful ',
            range: { start: { line: 0, character: 6 }, end: { line: 0, character: 6 } },
          },
        ],
      });

      expect(first(docs).content).toBe('hello beautiful world');
    });

    it('replaces text within a line', ({ expect }) => {
      let docs = openDoc(uri, 'hello world');
      docs = trackChange(docs, {
        textDocument: { uri, version: 2 },
        contentChanges: [
          {
            text: 'there',
            range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
          },
        ],
      });

      expect(first(docs).content).toBe('hello there');
    });

    it('replaces text across lines', ({ expect }) => {
      let docs = openDoc(uri, 'line1\nline2\nline3');
      docs = trackChange(docs, {
        textDocument: { uri, version: 2 },
        contentChanges: [
          {
            text: 'REPLACED',
            range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } },
          },
        ],
      });

      expect(first(docs).content).toBe('line1\nREPLACED\nline3');
    });

    it(String.raw`handles \r\n line endings`, ({ expect }) => {
      let docs = openDoc(uri, 'line1\r\nline2\r\nline3');
      docs = trackChange(docs, {
        textDocument: { uri, version: 2 },
        contentChanges: [
          {
            text: 'REPLACED',
            range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } },
          },
        ],
      });

      expect(first(docs).content).toBe('line1\r\nREPLACED\r\nline3');
    });

    it(String.raw`handles bare \r line endings`, ({ expect }) => {
      let docs = openDoc(uri, 'line1\rline2\rline3');
      docs = trackChange(docs, {
        textDocument: { uri, version: 2 },
        contentChanges: [
          {
            text: 'REPLACED',
            range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } },
          },
        ],
      });

      expect(first(docs).content).toBe('line1\rREPLACED\rline3');
    });

    it('deletes a range', ({ expect }) => {
      let docs = openDoc(uri, 'abcdef');
      docs = trackChange(docs, {
        textDocument: { uri, version: 2 },
        contentChanges: [
          {
            text: '',
            range: { start: { line: 0, character: 2 }, end: { line: 0, character: 4 } },
          },
        ],
      });

      expect(first(docs).content).toBe('abef');
    });

    it('applies multiple changes in sequence', ({ expect }) => {
      const replacement = faker.lorem.sentence();
      let docs = openDoc(uri, faker.lorem.sentence());
      docs = trackChange(docs, {
        textDocument: { uri, version: 2 },
        contentChanges: [
          // LSP spec: changes are applied sequentially to the original document
          { text: replacement }, // full replacement first
        ],
      });

      expect(first(docs).content).toBe(replacement);
    });
  });

  describe('trackClose', () => {
    it('removes document', ({ expect }) => {
      let docs = openDoc(uri, faker.lorem.word());
      docs = trackClose(docs, { textDocument: { uri } });

      expect(toArray(docs)).toStrictEqual([]);
    });

    it('is a no-op for unknown URI', ({ expect }) => {
      const docs = trackClose(empty(), { textDocument: { uri: fakeUri() } });

      expect(toArray(docs)).toStrictEqual([]);
    });
  });

  describe('edge cases', () => {
    it('ignores change for unknown document', ({ expect }) => {
      const docs = trackChange(empty(), {
        textDocument: { uri: fakeUri(), version: 2 },
        contentChanges: [{ text: faker.lorem.sentence() }],
      });

      expect(toArray(docs)).toStrictEqual([]);
    });

    it('tracks multiple documents independently', ({ expect }) => {
      let docs = openDoc(uriA, faker.lorem.word());
      docs = trackOpen(docs, {
        textDocument: { uri: uriB, languageId: 'javascript', version: 1, text: faker.lorem.word() },
      });

      expect(toArray(docs)).toHaveLength(2);
    });

    it('returns immutable state (original unchanged)', ({ expect }) => {
      const before = empty();
      const after = openDoc(uri, faker.lorem.word());

      expect(toArray(before)).toStrictEqual([]);
      expect(toArray(after)).toHaveLength(1);
    });
  });
});
