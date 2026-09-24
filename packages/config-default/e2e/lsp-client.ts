import { type ChildProcess, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  type Diagnostic,
  DidOpenTextDocumentNotification,
  ExitNotification,
  InitializeRequest,
  InitializedNotification,
  LogMessageNotification,
  PublishDiagnosticsNotification,
  RegistrationRequest,
  ShowMessageNotification,
  ShutdownRequest,
  UnregistrationRequest,
  createProtocolConnection,
} from 'vscode-languageserver-protocol/node.js';

const lineBreak = /\r?\n/v;
const maxStderrLines = 30;

/**
 * Answer a registration request with the empty result the protocol expects.
 */
const acceptRequest = (): undefined => undefined;

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
 *
 * The connection comes from `vscode-languageserver-protocol`, which is what
 * the proxy's own clients speak: it carries request correlation, the typed
 * method constants, and rejection of anything still in flight when the child
 * dies, none of which a hand-written client gets right for free.
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

  const stderr: string[] = [];
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    stderr.push(...chunk.split(lineBreak).filter(line => line.trim() !== ''));
  });

  const connection = createProtocolConnection(child.stdout, child.stdin);
  const published: { readonly diagnostics: readonly Diagnostic[]; readonly uri: string }[] = [];
  const listeners = new Set<() => void>();
  const logged: string[] = [];

  connection.onNotification(PublishDiagnosticsNotification.type, (params) => {
    published.push(params);
    for (const notify of listeners) notify();
  });
  for (const type of [LogMessageNotification.type, ShowMessageNotification.type]) {
    connection.onNotification(type, ({ message }) => {
      logged.push(message);
    });
  }
  connection.onNotification('eslint/status', (params: unknown) => {
    logged.push(`eslint/status ${JSON.stringify(params)}`);
  });

  /*
   * The requests the proxy passes through rather than answering itself.
   * Accepting them keeps a server from blocking on a client that never
   * replies; what is registered does not change what is asserted here.
   */
  connection.onRequest(RegistrationRequest.type, acceptRequest);
  connection.onRequest(UnregistrationRequest.type, acceptRequest);

  connection.listen();

  const rootUri = pathToFileURL(workspaceRoot).href;

  /*
   * The initialize response has to land before anything else is sent: the
   * proxy starts its child servers while answering it, and a didOpen that
   * arrives first reaches no server at all.
   */
  await connection.sendRequest(InitializeRequest.type, {
    capabilities: { textDocument: { publishDiagnostics: {} }, workspace: { configuration: true } },
    processId: process.pid,
    rootUri,
    workspaceFolders: [{ name: 'e2e', uri: rootUri }],
  });
  await connection.sendNotification(InitializedNotification.type, {});

  return {
    async openDocument(uri, languageId, text) {
      await connection.sendNotification(DidOpenTextDocumentNotification.type, {
        textDocument: { languageId, text, uri, version: 1 },
      });
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
            `Proxy stderr: ${stderr.slice(-maxStderrLines).join(' | ') || '(none)'}`,
          ].join('\n')));
        }, timeoutMs);

        listeners.add(check);
        check();
      }),
    async [Symbol.asyncDispose]() {
      /*
       * Shut down over the protocol rather than killing outright, so the proxy
       * gets to stop the language servers it started. The catch covers a proxy
       * that already died — the kill below is what settles it either way.
       */
      try {
        await connection.sendRequest(ShutdownRequest.type, undefined);
        await connection.sendNotification(ExitNotification.type);
      } catch {
        /*
         * Already gone; the kill below settles it either way.
         */
      }
      connection.dispose();
      child.kill();
    },
  };
};
