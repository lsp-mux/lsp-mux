import { describe, it } from 'vitest';
import { normalizeFileUri } from '../src/uri.ts';

describe('normalizeFileUri', () => {
  it('normalizes backslash URIs to forward slashes', ({ expect }) => {
    expect(normalizeFileUri(String.raw`file://C:\Users\test\file.ts`))
      .toBe('file:///c:/Users/test/file.ts');
  });

  it('canonicalizes uppercase drive letter to lowercase', ({ expect }) => {
    expect(normalizeFileUri('file:///C:/Users/test/file.ts'))
      .toBe('file:///c:/Users/test/file.ts');
  });

  it('preserves already-lowercase drive letter', ({ expect }) => {
    expect(normalizeFileUri('file:///c:/Users/test/file.ts'))
      .toBe('file:///c:/Users/test/file.ts');
  });

  it('returns non-file URIs unchanged', ({ expect }) => {
    expect(normalizeFileUri('untitled:Untitled-1'))
      .toBe('untitled:Untitled-1');
  });

  it('returns malformed URIs unchanged', ({ expect }) => {
    // Unterminated IPv6 host — new URL() rejects it on every platform, so
    // parsing fails and the input is returned as-is. (`file:not-a-uri` is a
    // valid URL that only fails path extraction on Windows, so it can't test
    // the catch branch cross-platform.)
    expect(normalizeFileUri('file://['))
      .toBe('file://[');
  });

  it('preserves percent-encoded paths', ({ expect }) => {
    const uri = normalizeFileUri('file:///C:/My%20Project/file.ts');

    expect(uri).toContain('My%20Project');
    expect(uri).toBe('file:///c:/My%20Project/file.ts');
  });

  it('is a no-op for Unix-style file URIs', ({ expect }) => {
    expect(normalizeFileUri('file:///home/user/file.ts'))
      .toBe('file:///home/user/file.ts');
  });
});
