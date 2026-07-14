import { describe, it } from 'vitest';
import { deepMerge } from '../src/deep-merge.ts';

describe('deepMerge', () => {
  it('merges flat objects', ({ expect }) => {
    expect(deepMerge({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });
  });

  it('override wins for scalar values', ({ expect }) => {
    expect(deepMerge({ a: 1 }, { a: 2 })).toEqual({ a: 2 });
  });

  it('deep merges nested objects', ({ expect }) => {
    const base = { settings: { validate: 'on', run: 'onType' } };
    const override = { settings: { run: 'onSave' } };

    expect(deepMerge(base, override)).toEqual({
      settings: { validate: 'on', run: 'onSave' },
    });
  });

  it('replaces arrays instead of merging', ({ expect }) => {
    const base = { args: ['--stdio', '--debug'] };
    const override = { args: ['--stdio'] };

    expect(deepMerge(base, override)).toEqual({ args: ['--stdio'] });
  });

  it('skips undefined values in override', ({ expect }) => {
    expect(deepMerge({ a: 1 }, { a: undefined })).toEqual({ a: 1 });
  });

  it('adds keys not present in base', ({ expect }) => {
    expect(deepMerge({}, { a: 1 })).toEqual({ a: 1 });
  });

  it('returns base unchanged for empty override', ({ expect }) => {
    const base = { a: 1, b: { c: 2 } };

    expect(deepMerge(base, {})).toEqual(base);
  });

  it('replaces object with scalar when override is scalar', ({ expect }) => {
    expect(deepMerge({ a: { nested: true } }, { a: 'flat' })).toEqual({ a: 'flat' });
  });

  it('replaces scalar with object when override is object', ({ expect }) => {
    expect(deepMerge({ a: 'flat' }, { a: { nested: true } })).toEqual({ a: { nested: true } });
  });

  it('handles null values in override as replacements', ({ expect }) => {
    /* eslint-disable-next-line unicorn/no-null --
       This test exercises null override semantics specifically. */
    expect(deepMerge({ a: { b: 1 } }, { a: null })).toEqual({ a: null });
  });

  it('does not mutate base or override', ({ expect }) => {
    const base = { settings: { validate: 'on' } };
    const override = { settings: { run: 'onSave' } };
    const baseCopy = JSON.parse(JSON.stringify(base)) as typeof base;
    const overrideCopy = JSON.parse(JSON.stringify(override)) as typeof override;

    deepMerge(base, override);

    expect(base).toEqual(baseCopy);
    expect(override).toEqual(overrideCopy);
  });
});
