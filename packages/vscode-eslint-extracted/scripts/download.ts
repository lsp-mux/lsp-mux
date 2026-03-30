import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { open, type Entry } from 'yauzl';
import type { Readable } from 'node:stream';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageDir = join(__dirname, '..');
const outDir = join(packageDir, 'dist');
const outFile = join(outDir, 'eslintServer.js');

if (existsSync(outFile)) {
  console.log('vscode-eslint-extracted: eslintServer.js already exists, skipping download');
  // eslint-disable-next-line n/no-process-exit -- early exit, not error handling
  process.exit(0);
}

const version = '3.0.24';
const url = `https://marketplace.visualstudio.com/_apis/public/gallery/publishers/dbaeumer/vsextensions/vscode-eslint/${version}/vspackage`;
const zipPath = join(packageDir, 'vscode-eslint.vsix');

console.log(`vscode-eslint-extracted: downloading vscode-eslint v${version}...`);

const response = await fetch(url);
if (!response.ok || !response.body) {
  throw new Error(`Download failed: ${String(response.status)} ${response.statusText}`);
}
await pipeline(response.body, createWriteStream(zipPath));

console.log('vscode-eslint-extracted: extracting eslintServer.js...');

const target = 'extension/server/out/eslintServer.js';
const data = await extractFileFromZip(zipPath, target);
if (!data) throw new Error(`${target} not found in VSIX`);

await mkdir(outDir, { recursive: true });
await writeFile(outFile, data);
await rm(zipPath, { force: true });
console.log('vscode-eslint-extracted: ready');

function extractFileFromZip(zipFilePath: string, entryName: string): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    open(zipFilePath, { lazyEntries: true }, (err: Error | null, zipfile) => {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- zipfile is undefined on error
      if (err || !zipfile) {
        reject(err ?? new Error('Failed to open zip'));
        return;
      }

      zipfile.readEntry();

      zipfile.on('entry', (entry: Entry) => {
        if (entry.fileName !== entryName) {
          zipfile.readEntry();
          return;
        }
        zipfile.openReadStream(entry, (readErr: Error | null, stream: Readable | undefined) => {
          if (readErr || !stream) {
            reject(readErr ?? new Error('Failed to open entry'));
            return;
          }
          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
          });
          stream.on('end', () => {
            resolve(Buffer.concat(chunks));
          });
        });
      });

      zipfile.on('end', () => {
        resolve(null);
      });
    });
  });
}
