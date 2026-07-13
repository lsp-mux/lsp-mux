import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const entriesDir = join(import.meta.dirname, '..', 'entries');
const outFile = join(import.meta.dirname, '..', 'src', 'entries.generated.ts');

const files = readdirSync(entriesDir).filter(f => f.endsWith('.json')).sort();

const properties = files.map((f) => {
  const name = basename(f, '.json');
  const json = readFileSync(join(entriesDir, f), 'utf-8').trimEnd();
  return `  ${JSON.stringify(name)}: ${json}`;
});

const source = `// Auto-generated from entries/*.json — do not edit manually.
// Regenerate: pnpm -C packages/registry generate

import type { RegistryEntry } from './index.ts';

export const entries: Readonly<Record<string, RegistryEntry>> = {
${properties.join(',\n')},
};
`;

writeFileSync(outFile, source);
