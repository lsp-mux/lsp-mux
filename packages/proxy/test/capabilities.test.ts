import { faker } from '@faker-js/faker';
import { describe, it } from 'vitest';
import { mergeCapabilities } from '../src/capabilities.ts';

describe('mergeCapabilities', () => {
  it('returns empty object for empty array', ({ expect }) => {
    expect(mergeCapabilities([])).toStrictEqual({});
  });

  it('returns capabilities unchanged for single server', ({ expect }) => {
    const caps = { hoverProvider: true, completionProvider: { triggerCharacters: ['.'] } };

    expect(mergeCapabilities([caps])).toStrictEqual(caps);
  });

  it('oRs boolean providers', ({ expect }) => {
    expect(mergeCapabilities([
      { hoverProvider: true },
      { hoverProvider: false },
    ])).toStrictEqual({ hoverProvider: true });

    expect(mergeCapabilities([
      { hoverProvider: false },
      { hoverProvider: true },
    ])).toStrictEqual({ hoverProvider: true });
  });

  it('merges disjoint providers from two servers', ({ expect }) => {
    expect(mergeCapabilities([
      { hoverProvider: true },
      { completionProvider: {} },
    ])).toStrictEqual({ hoverProvider: true, completionProvider: {} });
  });

  it('takes max for number values (textDocumentSync)', ({ expect }) => {
    expect(mergeCapabilities([
      { textDocumentSync: 1 },
      { textDocumentSync: 2 },
    ])).toStrictEqual({ textDocumentSync: 2 });

    expect(mergeCapabilities([
      { textDocumentSync: 2 },
      { textDocumentSync: 1 },
    ])).toStrictEqual({ textDocumentSync: 2 });
  });

  it('deep-merges nested object providers without losing keys', ({ expect }) => {
    expect(mergeCapabilities([
      { completionProvider: { triggerCharacters: ['.'], resolveProvider: true } },
      { completionProvider: { triggerCharacters: [':', '<'] } },
    ])).toStrictEqual({
      completionProvider: { triggerCharacters: ['.', ':', '<'], resolveProvider: true },
    });
  });

  it('shallow-merges object providers', ({ expect }) => {
    expect(mergeCapabilities([
      { completionProvider: { triggerCharacters: ['.'] } },
      { completionProvider: { resolveProvider: true } },
    ])).toStrictEqual({
      completionProvider: { triggerCharacters: ['.'], resolveProvider: true },
    });
  });

  it('concatenates array values', ({ expect }) => {
    const [first, second, third] = [faker.string.alpha(4), faker.string.alpha(4), faker.string.alpha(4)];

    expect(mergeCapabilities([
      { experimental: [first, second] },
      { experimental: [third] },
    ])).toStrictEqual({ experimental: [first, second, third] });
  });

  it('uses later value when types differ (fallback)', ({ expect }) => {
    expect(mergeCapabilities([
      { textDocumentSync: 1 },
      { textDocumentSync: { openClose: true, change: 2 } },
    ])).toStrictEqual({ textDocumentSync: { openClose: true, change: 2 } });
  });
});
