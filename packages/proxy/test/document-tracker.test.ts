import { describe, it, expect } from 'vitest';
import { empty, trackOpen, trackChange, trackClose, toArray } from '../src/document-tracker.js';
import type { DocumentMap } from '../src/document-tracker.js';
import type { TrackedDocument } from '../src/types.js';

const openDoc = (uri: string, text: string, version = 1) =>
  trackOpen(empty(), {
    textDocument: { uri, languageId: 'typescript', version, text },
  });

/** Get first document or fail — avoids `noUncheckedIndexedAccess` noise in tests. */
const first = (docs: DocumentMap): TrackedDocument => {
  const doc = toArray(docs)[0];
  if (!doc) throw new Error('Expected document');
  return doc;
};

describe('document-tracker', () => {
  describe('trackOpen', () => {
    it('stores document state', () => {
      const docs = openDoc('file:///test.ts', 'const x = 1;');
      expect(toArray(docs)).toEqual([
        { uri: 'file:///test.ts', languageId: 'typescript', version: 1, content: 'const x = 1;' },
      ]);
    });

    it('overwrites existing document at same URI', () => {
      let docs = openDoc('file:///a.ts', 'old');
      docs = trackOpen(docs, {
        textDocument: { uri: 'file:///a.ts', languageId: 'typescript', version: 2, text: 'new' },
      });
      expect(toArray(docs)).toStrictEqual([expect.objectContaining({ content: 'new' })]);
    });
  });

  describe('trackChange — full replacement', () => {
    it('replaces entire content', () => {
      let docs = openDoc('file:///test.ts', 'old');
      docs = trackChange(docs, {
        textDocument: { uri: 'file:///test.ts', version: 2 },
        contentChanges: [{ text: 'new' }],
      });
      expect(first(docs)).toMatchObject({ content: 'new', version: 2 });
    });
  });

  describe('trackChange — incremental', () => {
    it('inserts text at a position', () => {
      let docs = openDoc('file:///test.ts', 'hello world');
      docs = trackChange(docs, {
        textDocument: { uri: 'file:///test.ts', version: 2 },
        contentChanges: [
          {
            text: 'beautiful ',
            range: { start: { line: 0, character: 6 }, end: { line: 0, character: 6 } },
          },
        ],
      });
      expect(first(docs).content).toBe('hello beautiful world');
    });

    it('replaces text within a line', () => {
      let docs = openDoc('file:///test.ts', 'hello world');
      docs = trackChange(docs, {
        textDocument: { uri: 'file:///test.ts', version: 2 },
        contentChanges: [
          {
            text: 'there',
            range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
          },
        ],
      });
      expect(first(docs).content).toBe('hello there');
    });

    it('replaces text across lines', () => {
      let docs = openDoc('file:///test.ts', 'line1\nline2\nline3');
      docs = trackChange(docs, {
        textDocument: { uri: 'file:///test.ts', version: 2 },
        contentChanges: [
          {
            text: 'REPLACED',
            range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } },
          },
        ],
      });
      expect(first(docs).content).toBe('line1\nREPLACED\nline3');
    });

    it('handles \\r\\n line endings', () => {
      let docs = openDoc('file:///test.ts', 'line1\r\nline2\r\nline3');
      docs = trackChange(docs, {
        textDocument: { uri: 'file:///test.ts', version: 2 },
        contentChanges: [
          {
            text: 'REPLACED',
            range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } },
          },
        ],
      });
      expect(first(docs).content).toBe('line1\r\nREPLACED\r\nline3');
    });

    it('handles bare \\r line endings', () => {
      let docs = openDoc('file:///test.ts', 'line1\rline2\rline3');
      docs = trackChange(docs, {
        textDocument: { uri: 'file:///test.ts', version: 2 },
        contentChanges: [
          {
            text: 'REPLACED',
            range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } },
          },
        ],
      });
      expect(first(docs).content).toBe('line1\rREPLACED\rline3');
    });

    it('deletes a range', () => {
      let docs = openDoc('file:///test.ts', 'abcdef');
      docs = trackChange(docs, {
        textDocument: { uri: 'file:///test.ts', version: 2 },
        contentChanges: [
          {
            text: '',
            range: { start: { line: 0, character: 2 }, end: { line: 0, character: 4 } },
          },
        ],
      });
      expect(first(docs).content).toBe('abef');
    });

    it('applies multiple changes in sequence', () => {
      let docs = openDoc('file:///test.ts', 'aaa');
      docs = trackChange(docs, {
        textDocument: { uri: 'file:///test.ts', version: 2 },
        contentChanges: [
          // LSP spec: changes are applied sequentially to the original document
          { text: 'bbb' }, // full replacement first
        ],
      });
      expect(first(docs).content).toBe('bbb');
    });
  });

  describe('trackClose', () => {
    it('removes document', () => {
      let docs = openDoc('file:///test.ts', 'x');
      docs = trackClose(docs, { textDocument: { uri: 'file:///test.ts' } });
      expect(toArray(docs)).toStrictEqual([]);
    });

    it('is a no-op for unknown URI', () => {
      const docs = trackClose(empty(), { textDocument: { uri: 'file:///unknown.ts' } });
      expect(toArray(docs)).toStrictEqual([]);
    });
  });

  describe('edge cases', () => {
    it('ignores change for unknown document', () => {
      const docs = trackChange(empty(), {
        textDocument: { uri: 'file:///unknown.ts', version: 2 },
        contentChanges: [{ text: 'new' }],
      });
      expect(toArray(docs)).toStrictEqual([]);
    });

    it('tracks multiple documents independently', () => {
      let docs = openDoc('file:///a.ts', 'a');
      docs = trackOpen(docs, {
        textDocument: { uri: 'file:///b.ts', languageId: 'javascript', version: 1, text: 'b' },
      });
      expect(toArray(docs)).toHaveLength(2);
    });

    it('returns immutable state (original unchanged)', () => {
      const before = empty();
      const after = openDoc('file:///test.ts', 'x');
      expect(toArray(before)).toStrictEqual([]);
      expect(toArray(after)).toHaveLength(1);
    });
  });
});
