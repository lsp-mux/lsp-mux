import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';

const ManifestSchema = v.looseObject({
  publishConfig: v.optional(v.object({
    directory: v.optional(v.string()),
    scripts: v.optional(v.record(v.string(), v.string())),
  })),
  scripts: v.optional(v.record(v.string(), v.string())),
});

const NPMIGNORE = '*.tsbuildinfo\n';

const packagesDir = join(import.meta.dirname, '..', 'packages');

for (const name of readdirSync(packagesDir)) {
  const pkgDir = join(packagesDir, name);
  const manifest = v.parse(ManifestSchema, JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf-8')));
  const dir = manifest.publishConfig?.directory;
  if (!dir) continue;

  const output = { ...manifest };
  if (manifest.publishConfig?.scripts) {
    output.scripts = { ...manifest.scripts, ...manifest.publishConfig.scripts };
  }

  const target = join(pkgDir, dir);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'package.json'), JSON.stringify(output, null, 2) + '\n');
  writeFileSync(join(target, '.npmignore'), NPMIGNORE);
}
