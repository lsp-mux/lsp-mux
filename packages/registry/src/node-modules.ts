import { existsSync } from 'node:fs';
import path from 'node:path';

const nodeModulesDir = 'node_modules';
const nodeModulesPrefix = `./${nodeModulesDir}/`;

/**
 * Every `node_modules` Node would search for a bare specifier required from
 * `fromDir`, nearest first — the directory's own, then each ancestor's.
 * @yields Each candidate `node_modules` directory, nearest first.
 */
export const nodeModulesPaths = function* (fromDir: string): Generator<string> {
  let dir = path.resolve(fromDir);
  for (;;) {
    if (path.basename(dir) !== nodeModulesDir) yield path.join(dir, nodeModulesDir);
    const parent = path.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
};

/**
 * Resolve a `./node_modules/...` path against the nearest ancestor directory
 * that actually holds it, the way Node resolves a module. Returns `undefined`
 * for any other path, and for one no ancestor has.
 *
 * A server's entry point is spelled this way in the registry, and only pnpm's
 * symlinked workspace layout puts a package's dependencies beneath it. npm and
 * yarn hoist them to the project root, so resolving against the config
 * directory alone names a path that does not exist.
 */
export const resolveNodeModulesPath = (
  filePath: string,
  fromDir: string,
): string | undefined => {
  if (!filePath.startsWith(nodeModulesPrefix)) return undefined;

  const subpath = filePath.slice(nodeModulesPrefix.length);
  for (const nodeModules of nodeModulesPaths(fromDir)) {
    const candidate = path.join(nodeModules, subpath);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
};
