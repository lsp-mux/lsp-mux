import { describe, it } from 'vitest';
import { deepMerge } from '../src/deep-merge.ts';

describe('deepMerge', () => {
  it('merges flat objects', ({ expect }) => {
    expect(deepMerge({ foo: 1 }, { bar: 2 })).toStrictEqual({ foo: 1, bar: 2 });
  });

  it('override wins for scalar values', ({ expect }) => {
    expect(deepMerge({ foo: 1 }, { foo: 2 })).toStrictEqual({ foo: 2 });
  });

  it('deep merges nested objects', ({ expect }) => {
    const base = { settings: { validate: 'on', run: 'onType' } };
    const override = { settings: { run: 'onSave' } };

    expect(deepMerge(base, override)).toStrictEqual({
      settings: { validate: 'on', run: 'onSave' },
    });
  });

  it('replaces arrays instead of merging', ({ expect }) => {
    const base = { args: ['--stdio', '--debug'] };
    const override = { args: ['--stdio'] };

    expect(deepMerge(base, override)).toStrictEqual({ args: ['--stdio'] });
  });

  it('skips undefined values in override', ({ expect }) => {
    expect(deepMerge({ foo: 1 }, { foo: undefined })).toStrictEqual({ foo: 1 });
  });

  it('adds keys not present in base', ({ expect }) => {
    expect(deepMerge({}, { foo: 1 })).toStrictEqual({ foo: 1 });
  });

  it('returns base unchanged for empty override', ({ expect }) => {
    const base = { foo: 1, bar: { baz: 2 } };

    expect(deepMerge(base, {})).toStrictEqual(base);
  });

  it('replaces object with scalar when override is scalar', ({ expect }) => {
    expect(deepMerge({ foo: { nested: true } }, { foo: 'flat' })).toStrictEqual({ foo: 'flat' });
  });

  it('replaces scalar with object when override is object', ({ expect }) => {
    expect(deepMerge({ foo: 'flat' }, { foo: { nested: true } })).toStrictEqual({ foo: { nested: true } });
  });

  it('handles null values in override as replacements', ({ expect }) => {
    /* eslint-disable-next-line unicorn/no-null --
       This test exercises null override semantics specifically. */
    expect(deepMerge({ foo: { bar: 1 } }, { foo: null })).toStrictEqual({ foo: null });
  });

  it('does not mutate base or override', ({ expect }) => {
    const base = { settings: { validate: 'on' } };
    const override = { settings: { run: 'onSave' } };
    const baseCopy = structuredClone(base);
    const overrideCopy = structuredClone(override);

    deepMerge(base, override);

    expect(base).toStrictEqual(baseCopy);
    expect(override).toStrictEqual(overrideCopy);
  });
});
