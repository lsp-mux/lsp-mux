import { access } from 'node:fs/promises';
import path from 'node:path';

/**
 * Verify that an npm package is installed in the config directory's
 * node_modules. Throws with an actionable install command if missing.
 */
export const validateNpmPackage = async (
  npmPackage: string,
  configDir: string,
  serverName: string,
): Promise<void> => {
  const pkgPath = path.join(configDir, 'node_modules', npmPackage);
  try {
    await access(pkgPath);
  } catch {
    throw new Error(
      `Server "${serverName}" requires "${npmPackage}" ` +
      `but it was not found in ${configDir}. ` +
      `Install it with: npm install ${npmPackage}`,
    );
  }
};
