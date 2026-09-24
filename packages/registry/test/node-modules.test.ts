import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'vitest';
import { resolveNodeModulesPath } from '../src/node-modules.ts';

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

describe('resolveNodeModulesPath', () => {
  it('finds a package hoisted to an ancestor node_modules', async ({ expect }) => {
    await using tmp = await createTempDir('hoisted');
    const configDir = path.join(tmp.dir, 'node_modules', 'config-pkg');
    await mkdir(configDir, { recursive: true });
    const binary = path.join(tmp.dir, 'node_modules', 'some-server', 'bin', 'run.js');
    await mkdir(path.dirname(binary), { recursive: true });
    await writeFile(binary, '');

    /*
     * The registry spells a server's entry point `./node_modules/<pkg>/...`,
     * which only lands beside the config package under pnpm's symlinked
     * layout. npm and yarn hoist it to the project root instead, so the
     * launch path has to be searched the way Node searches for a module.
     */
    expect(resolveNodeModulesPath('./node_modules/some-server/bin/run.js', configDir))
      .toBe(binary);
  });

  it('prefers the nearest node_modules when both have the package', async ({ expect }) => {
    await using tmp = await createTempDir('nearest');
    const configDir = path.join(tmp.dir, 'node_modules', 'config-pkg');
    const near = path.join(configDir, 'node_modules', 'some-server', 'run.js');
    const far = path.join(tmp.dir, 'node_modules', 'some-server', 'run.js');
    await mkdir(path.dirname(near), { recursive: true });
    await mkdir(path.dirname(far), { recursive: true });
    await writeFile(near, '');
    await writeFile(far, '');

    expect(resolveNodeModulesPath('./node_modules/some-server/run.js', configDir)).toBe(near);
  });

  it('returns undefined when no ancestor has the package', async ({ expect }) => {
    await using tmp = await createTempDir('absent');

    expect(resolveNodeModulesPath('./node_modules/absent/run.js', tmp.dir)).toBeUndefined();
  });

  it('returns undefined for a relative path that is not under node_modules', async ({ expect }) => {
    await using tmp = await createTempDir('other');
    await writeFile(path.join(tmp.dir, 'server.js'), '');

    /*
     * Only the node_modules prefix means "wherever the installer put it". A
     * config's own files are addressed relative to the config dir and must
     * keep resolving there, so the caller's plain resolve still handles them.
     */
    expect(resolveNodeModulesPath('./server.js', tmp.dir)).toBeUndefined();
  });
});
