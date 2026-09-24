import { type ChildProcess, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as v from 'valibot';
import type {
  Message, NotificationMessage, RequestMessage, ResponseMessage,
} from 'vscode-jsonrpc';
import { StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node.js';

const CodeSchema = v.union([v.string(), v.number()]);

const DiagnosticSchema = v.object({
  code: v.optional(CodeSchema),
  message: v.string(),
  source: v.optional(v.string()),
});

const PublishDiagnosticsSchema = v.object({
  diagnostics: v.array(DiagnosticSchema),
  uri: v.string(),
});

export type Diagnostic = v.InferOutput<typeof DiagnosticSchema>;
type PublishDiagnosticsParams = v.InferOutput<typeof PublishDiagnosticsSchema>;

const lineBreak = /\r?\n/v;

const asRecord = (message: Message): Record<string, unknown> => ({ ...message });

/*
 * A server may spell a document's URI differently from the client that opened
 * it — percent-encoding the drive colon, or disagreeing about its case — so
 * comparing the strings drops diagnostics that are about the same file.
 * Compare the paths they denote instead.
 */
const isSameDocument = (left: string, right: string): boolean => {
  try {
    const leftPath = fileURLToPath(left);
    const rightPath = fileURLToPath(right);
    return process.platform === 'win32'
      ? leftPath.toLowerCase() === rightPath.toLowerCase()
      : leftPath === rightPath;
  } catch {
    return left === right;
  }
};

const logMethods = new Set(['window/logMessage', 'window/showMessage']);

/**
 * Anything a server says about itself, kept so a timeout can report what the
 * servers were doing rather than only that nothing arrived.
 */
const serverNote = (record: Record<string, unknown>): string | undefined => {
  const method = record['method'];
  if (typeof method !== 'string') return undefined;
  if (method === 'eslint/status') return `eslint/status ${JSON.stringify(record['params'])}`;
  if (!logMethods.has(method)) return undefined;
  const parsed = v.safeParse(v.object({ message: v.string() }), record['params']);
  return parsed.success ? parsed.output.message : undefined;
};

const publishedParams = (message: Message): PublishDiagnosticsParams | undefined => {
  const record = asRecord(message);
  if (record['method'] !== 'textDocument/publishDiagnostics') return undefined;
  const parsed = v.safeParse(PublishDiagnosticsSchema, record['params']);
  return parsed.success ? parsed.output : undefined;
};

export interface ProxyClient {
  /**
   * Resolve once a published diagnostic for `uri` matches. Waiting on the
   * diagnostic rather than on a delay is what keeps a slow server from
   * deciding the result: the servers report independently and in any order.
   */
  readonly waitForDiagnostic: (
    uri: string,
    isMatch: (diagnostic: Diagnostic) => boolean,
    timeoutMs?: number,
  ) => Promise<Diagnostic>;
  readonly openDocument: (uri: string, languageId: string, text: string) => Promise<void>;
  readonly [Symbol.asyncDispose]: () => Promise<void>;
}

/**
 * Drive a proxy over stdio far enough to open a document and collect what the
 * servers behind it report.
 */
export const startProxy = async (
  command: string,
  args: readonly string[],
  workspaceRoot: string,
): Promise<ProxyClient> => {
  const child: ChildProcess = spawn(command, [...args], {
    cwd: workspaceRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (!child.stdout || !child.stdin) throw new Error('proxy was spawned without stdio pipes');

  const reader = new StreamMessageReader(child.stdout);
  const writer = new StreamMessageWriter(child.stdin);
  const published: PublishDiagnosticsParams[] = [];
  const listeners = new Set<() => void>();
  const logged: string[] = [];
  const stderr: string[] = [];
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    const lines = chunk.split(lineBreak).filter(line => line.trim() !== '');
    stderr.push(...lines);
  });
  const pending = new Map<number, (message: Record<string, unknown>) => void>();

  reader.listen((message) => {
    const record = asRecord(message);
    const id = record['id'];

    if (typeof id === 'number' && record['method'] === undefined) {
      pending.get(id)?.(record);
      pending.delete(id);
      return;
    }

    /*
     * A server request the proxy passes through — capability registration,
     * mostly. Answering keeps the server from blocking on a client that never
     * replies; the content does not matter to what is asserted here.
     */
    if (typeof id === 'number') {
      /* eslint-disable-next-line unicorn/no-null --
         JSON-RPC requires a present result; undefined would omit the key. */
      const ack: ResponseMessage = { id, jsonrpc: '2.0', result: null };
      void writer.write(ack);
      return;
    }

    const note = serverNote(record);
    if (note !== undefined) {
      logged.push(note);
      return;
    }

    const params = publishedParams(message);
    if (params === undefined) return;
    published.push(params);
    for (const notify of listeners) notify();
  });

  let nextId = 1;
  const request = async (method: string, params: object): Promise<Record<string, unknown>> => {
    const id = nextId++;
    const response = new Promise<Record<string, unknown>>((resolve) => {
      pending.set(id, resolve);
    });
    const message: RequestMessage = { id, jsonrpc: '2.0', method, params };
    await writer.write(message);
    return response;
  };

  const rootUri = pathToFileURL(workspaceRoot).href;

  /*
   * The initialize response has to land before anything else is sent: the
   * proxy starts its child servers while answering it, and a didOpen that
   * arrives first reaches no server at all.
   */
  await request('initialize', {
    capabilities: {
      textDocument: { publishDiagnostics: {} },
      workspace: { configuration: true, workspaceFolders: true },
    },
    processId: process.pid,
    rootUri,
    workspaceFolders: [{ name: 'e2e', uri: rootUri }],
  });
  const initialized: NotificationMessage = {
    jsonrpc: '2.0', method: 'initialized', params: {},
  };
  await writer.write(initialized);

  return {
    async openDocument(uri, languageId, text) {
      const notification: NotificationMessage = {
        jsonrpc: '2.0',
        method: 'textDocument/didOpen',
        params: { textDocument: { languageId, text, uri, version: 1 } },
      };
      await writer.write(notification);
    },
    waitForDiagnostic: (uri, isMatch, timeoutMs = 90_000) =>
      new Promise((resolve, reject) => {
        const cleanUp = (): void => {
          clearTimeout(timer);
          listeners.delete(check);
        };

        const check = (): void => {
          const found = published
            .filter(params => isSameDocument(params.uri, uri))
            .flatMap(params => [...params.diagnostics])
            .find(diagnostic => isMatch(diagnostic));
          if (found === undefined) return;
          cleanUp();
          resolve(found);
        };

        const timer = setTimeout(() => {
          cleanUp();
          const seen = published.map(params =>
            `${params.uri} -> ${params.diagnostics
              .map(diagnostic => `${diagnostic.source ?? '?'}:${String(diagnostic.code ?? '?')}`)
              .join(', ') || '(empty)'}`);
          reject(new Error([
            `Timed out waiting for a diagnostic on ${uri}.`,
            `Published: ${seen.join(' | ') || '(nothing)'}`,
            `Server messages: ${logged.slice(-20).join(' | ') || '(none)'}`,
            `Proxy stderr: ${stderr.slice(-30).join(' | ') || '(none)'}`,
          ].join('\n')));
        }, timeoutMs);

        listeners.add(check);
        check();
      }),
    async [Symbol.asyncDispose]() {
      const shutdown: RequestMessage = { id: nextId++, jsonrpc: '2.0', method: 'shutdown' };
      try {
        await writer.write(shutdown);
      } catch {
        /*
         * The proxy may already be gone; the kill below is what matters.
         */
      }
      reader.dispose();
      child.kill();
    },
  };
};
