import { execSync } from 'node:child_process';
import { join } from 'node:path';

const destination = join(import.meta.dirname, '..', 'dist', 'packages');
execSync(`pnpm -r pack --pack-destination ${destination}`, {
  stdio: 'inherit',
});
