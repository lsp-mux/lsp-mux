import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { test } from 'vitest';
import { StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node.js';
import { LspProxy } from '../../src/proxy.js';
import type { ServerConfig } from '../../src/types.js';

export type { LspProxy, ServerConfig };

export const MOCK_SERVER = join(import.meta.dirname, '..', 'helpers', 'mock-server.ts');

export const mockServerConfig: ServerConfig = {
  command: process.execPath,
  args: ['--import', 'tsx', MOCK_SERVER],
  languages: { typescript: ['.ts'] },
  transport: 'stdio',
};

interface TestProxyOptions {
  config?: ServerConfig;
  restartPolicy?: Partial<{ maxRetries: number; baseDelayMs: number; maxDelayMs: number }>;
  maxResyncBytes?: number;
  maxPendingEvents?: number;
}

export const createTestProxy = ({
  config = mockServerConfig,
  restartPolicy,
  ...extraOptions
}: TestProxyOptions = {}) => {
  const clientToProxy = new PassThrough();
  const proxyToClient = new PassThrough();

  const proxy = new LspProxy(
    new Map([['mock', config]]),
    {
      input: clientToProxy,
      output: proxyToClient,
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

export interface Workspace {
  dir: string;
  uri: string;
  nextSeq: () => number;
}

export const it = test.extend<{
  createProxy: (opts?: TestProxyOptions) => ReturnType<typeof createTestProxy> & { started: Promise<void> };
  workspace: Workspace;
}>({
  createProxy: async ({}, use) => {
    const instances: LspProxy[] = [];
    await use((opts) => {
      const ctx = createTestProxy(opts);
      instances.push(ctx.proxy);
      const started = ctx.proxy.start();
      return { ...ctx, started };
    });
    for (const p of instances) p.dispose();
  },
  workspace: async ({}, use) => {
    const dir = join(import.meta.dirname, '..', '..', `tmp-workspace-${randomUUID().slice(0, 8)}`);
    await mkdir(dir, { recursive: true });
    let seq = 100;
    await use({ dir, uri: pathToFileURL(dir).href, nextSeq: () => seq++ });
    await rm(dir, { recursive: true, force: true }).catch(() => { /* ignore */ });
  },
});
