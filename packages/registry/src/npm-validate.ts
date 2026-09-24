import { access } from 'node:fs/promises';
import path from 'node:path';
import { nodeModulesPaths } from './node-modules.ts';

const isReadable = async (target: string): Promise<boolean> => {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
};

/**
 * Verify that an npm package is resolvable from the config directory. Throws
 * with an actionable install command if missing.
 *
 * Searching every ancestor `node_modules` rather than only the config
 * directory's own is what makes this hold outside this repo: npm and yarn
 * hoist a package's dependencies to the project root, leaving the config
 * package with no `node_modules` at all.
 */
export const validateNpmPackage = async (
  npmPackage: string,
  configDir: string,
  serverName: string,
): Promise<void> => {
  for (const nodeModules of nodeModulesPaths(configDir)) {
    if (await isReadable(path.join(nodeModules, npmPackage))) return;
  }

  throw new Error(
    `Server "${serverName}" requires "${npmPackage}" ` +
    `but it was not found from ${configDir}. ` +
    `Install it with: npm install ${npmPackage}`,
  );
};
