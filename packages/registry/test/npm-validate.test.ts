import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'vitest';
import { validateNpmPackage } from '../src/npm-validate.ts';

/**
 * Create an isolated temp dir. Disposable so `await using` removes it.
 */
const createTempDir = async (name: string) => {
  const dir = path.join(
    import.meta.dirname, '..', 'dist', 'test-fixtures', randomUUID().slice(0, 8), name,
  );
  await mkdir(dir, { recursive: true });
  return {
    dir,
    async [Symbol.asyncDispose]() {
      await rm(dir, { recursive: true, force: true });
    },
  };
};

describe('validateNpmPackage', () => {
  it('resolves when package exists', async ({ expect }) => {
    await using tmp = await createTempDir('exists');
    await mkdir(path.join(tmp.dir, 'node_modules', 'fake-pkg'), { recursive: true });

    await expect(validateNpmPackage('fake-pkg', tmp.dir, 'test')).resolves.toBeUndefined();
  });

  it('resolves when the package is hoisted to an ancestor node_modules', async ({ expect }) => {
    await using tmp = await createTempDir('hoisted');
    const configDir = path.join(tmp.dir, 'node_modules', 'some-config-pkg');
    await mkdir(configDir, { recursive: true });
    await mkdir(path.join(tmp.dir, 'node_modules', 'fake-pkg'), { recursive: true });

    /*
     * npm and yarn hoist a package's dependencies to the project root, so the
     * config package has no node_modules of its own and the dependency sits
     * beside it. Only pnpm's symlinked workspace layout puts it underneath,
     * which is why checking a single literal path passes in this repo and
     * fails for anyone installing the published package.
     */
    await expect(validateNpmPackage('fake-pkg', configDir, 'test')).resolves.toBeUndefined();
  });

  it('throws with actionable message when package is missing', async ({ expect }) => {
    await using tmp = await createTempDir('missing');

    await expect(validateNpmPackage('@scope/pkg', tmp.dir, 'myserver'))
      .rejects.toThrow(/requires "@scope\/pkg"/v);
  });

  it('includes install command in error', async ({ expect }) => {
    await using tmp = await createTempDir('install-cmd');

    await expect(validateNpmPackage('some-pkg', tmp.dir, 'test'))
      .rejects.toThrow(/npm install some-pkg/v);
  });
});
