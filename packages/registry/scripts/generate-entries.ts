import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const entriesDir = path.join(import.meta.dirname, '..', 'entries');
const outFile = path.join(import.meta.dirname, '..', 'src', 'entries.generated.ts');

const files = readdirSync(entriesDir)
  .filter(fileName => fileName.endsWith('.json'))
  .toSorted((left, right) => left.localeCompare(right));

const properties = files.map((fileName) => {
  const name = path.basename(fileName, '.json');
  const json = readFileSync(path.join(entriesDir, fileName), 'utf8').trimEnd();
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
