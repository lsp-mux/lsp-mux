import { describe, it } from 'vitest';
import { faker } from '@faker-js/faker';
import { mergeCapabilities } from '../src/capabilities.ts';

describe('mergeCapabilities', () => {
  it('returns empty object for empty array', ({ expect }) => {
    expect(mergeCapabilities([])).toEqual({});
  });

  it('returns capabilities unchanged for single server', ({ expect }) => {
    const caps = { hoverProvider: true, completionProvider: { triggerCharacters: ['.'] } };
    expect(mergeCapabilities([caps])).toEqual(caps);
  });

  it('ORs boolean providers', ({ expect }) => {
    expect(mergeCapabilities([
      { hoverProvider: true },
      { hoverProvider: false },
    ])).toEqual({ hoverProvider: true });

    expect(mergeCapabilities([
      { hoverProvider: false },
      { hoverProvider: true },
    ])).toEqual({ hoverProvider: true });
  });

  it('merges disjoint providers from two servers', ({ expect }) => {
    expect(mergeCapabilities([
      { hoverProvider: true },
      { completionProvider: {} },
    ])).toEqual({ hoverProvider: true, completionProvider: {} });
  });

  it('takes max for number values (textDocumentSync)', ({ expect }) => {
    expect(mergeCapabilities([
      { textDocumentSync: 1 },
      { textDocumentSync: 2 },
    ])).toEqual({ textDocumentSync: 2 });

    expect(mergeCapabilities([
      { textDocumentSync: 2 },
      { textDocumentSync: 1 },
    ])).toEqual({ textDocumentSync: 2 });
  });

  it('deep-merges nested object providers without losing keys', ({ expect }) => {
    expect(mergeCapabilities([
      { completionProvider: { triggerCharacters: ['.'], resolveProvider: true } },
      { completionProvider: { triggerCharacters: [':', '<'] } },
    ])).toEqual({
      completionProvider: { triggerCharacters: ['.', ':', '<'], resolveProvider: true },
    });
  });

  it('shallow-merges object providers', ({ expect }) => {
    expect(mergeCapabilities([
      { completionProvider: { triggerCharacters: ['.'] } },
      { completionProvider: { resolveProvider: true } },
    ])).toEqual({
      completionProvider: { triggerCharacters: ['.'], resolveProvider: true },
    });
  });

  it('concatenates array values', ({ expect }) => {
    const [a, b, c] = [faker.string.alpha(4), faker.string.alpha(4), faker.string.alpha(4)];
    expect(mergeCapabilities([
      { experimental: [a, b] },
      { experimental: [c] },
    ])).toEqual({ experimental: [a, b, c] });
  });

  it('uses later value when types differ (fallback)', ({ expect }) => {
    expect(mergeCapabilities([
      { textDocumentSync: 1 },
      { textDocumentSync: { openClose: true, change: 2 } },
    ])).toEqual({ textDocumentSync: { openClose: true, change: 2 } });
  });
});
