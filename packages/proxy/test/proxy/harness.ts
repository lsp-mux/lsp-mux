import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { test } from 'vitest';
import { StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node.js';
import { createLogger } from '../../src/logger.ts';
import type { Logger } from '../../src/logger.ts';
import { LspProxy } from '../../src/proxy.ts';
import type { ServerConfig } from '../../src/types.ts';
import { normalizeFileUri } from '../../src/uri.ts';

export const mockServer = join(import.meta.dirname, '..', 'helpers', 'mock-server.ts');

export const mockServerConfig: ServerConfig = {
  command: process.execPath,
  args: [mockServer],
  languages: { typescript: ['.ts'] },
  transport: 'stdio',
};

export const namedConfig = (name: string, ...extraArgs: string[]): ServerConfig => ({
  ...mockServerConfig,
  args: [...mockServerConfig.args, `--name=${name}`, ...extraArgs],
});

interface TestProxyOptions {
  config?: ServerConfig;
  configs?: ReadonlyMap<string, ServerConfig>;
  logger?: Logger;
  restartPolicy?: Partial<{ maxRetries: number; baseDelayMs: number; maxDelayMs: number }>;
  maxResyncBytes?: number;
  maxPendingEvents?: number;
}

export const createTestProxy = ({
  config = mockServerConfig,
  configs,
  logger,
  restartPolicy,
  ...extraOptions
}: TestProxyOptions = {}) => {
  const clientToProxy = new PassThrough();
  const proxyToClient = new PassThrough();

  const proxy = new LspProxy(
    configs ?? new Map([['mock', config]]),
    {
      input: clientToProxy,
      output: proxyToClient,
      logger,
      restartPolicy: { maxRetries: 3, baseDelayMs: 50, maxDelayMs: 200, ...restartPolicy },
      ...extraOptions,
    },
  );

  // Avoid MaxListenersExceeded warnings from vi.waitFor polling
  proxyToClient.setMaxListeners(50);

  const writer = new StreamMessageWriter(clientToProxy);
  const reader = new StreamMessageReader(proxyToClient);

  return { proxy, writer, reader, clientToProxy, proxyToClient };
};

export interface WorkspaceFile {
  path: string;
  uri: string;
}

export interface Workspace {
  dir: string;
  uri: string;
  file: (relativePath: string) => WorkspaceFile;
  nextSeq: () => number;
}

export const it = test.extend<{
  createProxy: (opts?: TestProxyOptions) => ReturnType<typeof createTestProxy> & { started: Promise<void> };
  workspace: Workspace;
}>({
  createProxy: async ({}, use) => {
    const instances: LspProxy[] = [];
    const logBuffer: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        logBuffer.push(String(chunk));
        cb();
      },
    });
    const logger = createLogger(sink);

    try {
      await use((opts) => {
        const ctx = createTestProxy({ logger, ...opts });
        instances.push(ctx.proxy);
        const started = ctx.proxy.start();
        return { ...ctx, started };
      });
    } catch (error) {
      for (const line of logBuffer) process.stderr.write(line);
      throw error;
    } finally {
      for (const p of instances) p.dispose();
    }
  },
  workspace: async ({}, use) => {
    const dir = join(import.meta.dirname, '..', '..', 'dist', 'test-workspaces', randomUUID().slice(0, 8));
    await mkdir(dir, { recursive: true });
    let seq = 100;
    const uri = normalizeFileUri(pathToFileURL(dir).href);
    const file = (rel: string) => {
      const p = join(dir, rel);
      return { path: p, uri: normalizeFileUri(pathToFileURL(p).href) };
    };
    await use({ dir, uri, file, nextSeq: () => seq++ });
    await rm(dir, { recursive: true, force: true }).catch(() => { /* ignore */ });
  },
});

export { type LspProxy } from '../../src/proxy.ts';
export { type ServerConfig } from '../../src/types.ts';
