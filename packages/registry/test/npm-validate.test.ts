import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, it } from 'vitest';
import { validateNpmPackage } from '../src/npm-validate.ts';

const tmpDir = join(import.meta.dirname, '..', 'dist', 'test-fixtures', randomUUID().slice(0, 8));

describe('validateNpmPackage', () => {
  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });
  it('resolves when package exists', async ({ expect }) => {
    const dir = join(tmpDir, 'exists');
    await mkdir(join(dir, 'node_modules', 'fake-pkg'), { recursive: true });
    await expect(validateNpmPackage('fake-pkg', dir, 'test')).resolves.toBeUndefined();
  });

  it('throws with actionable message when package is missing', async ({ expect }) => {
    const dir = join(tmpDir, 'missing');
    await mkdir(dir, { recursive: true });
    await expect(validateNpmPackage('@scope/pkg', dir, 'myserver'))
      .rejects.toThrow(/requires "@scope\/pkg"/);
  });

  it('includes install command in error', async ({ expect }) => {
    const dir = join(tmpDir, 'install-cmd');
    await mkdir(dir, { recursive: true });
    await expect(validateNpmPackage('some-pkg', dir, 'test'))
      .rejects.toThrow(/npm install some-pkg/);
  });
});
