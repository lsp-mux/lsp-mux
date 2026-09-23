/**
 * Minimal mock LSP server for integration tests.
 * Reads JSON-RPC from stdin, responds to initialize, echoes everything else.
 * Tracks open documents so tests can verify replay after restart.
 * Publishes diagnostics on didOpen with source set to server name.
 * Exits on "exit" notification or SIGTERM.
 *
 * Usage: node --import tsx mock-server.ts [--name=<serverName>]
 */
import * as v from 'valibot';
import type { ResponseMessage } from 'vscode-jsonrpc';
import { StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node.js';
import {
  DidChangeParamsSchema,
  DidCloseParamsSchema,
  DidOpenParamsSchema,
} from '../../src/document-tracker.ts';
import {
  Message as Msg,
  type NotificationMessage,
  type RequestMessage,
  createNotification,
  createRequest,
} from '../../src/types.ts';

const serverName = process.argv.find(arg => arg.startsWith('--name='))?.slice(7) ?? 'mock';
const isRegisterWatchers = process.argv.includes('--register-watchers');
const isRegisterMixed = process.argv.includes('--register-mixed');
const isIncrementalSync = process.argv.includes('--incremental-sync');
const isUnregisterOnCommand = process.argv.includes('--unregister-on-command');
const isSendCustomRequest = process.argv.includes('--send-custom-request');
const isTrackConfig = process.argv.includes('--track-config');
const isRequestConfig = process.argv.includes('--request-config');
const isRegisterConfig = process.argv.includes('--register-config');
const isPullDiagnostics = process.argv.includes('--pull-diagnostics');
const isInitializeError = process.argv.includes('--initialize-error');
const isTsserverClient = process.argv.includes('--tsserver-client');
const isExecuteCommandError = process.argv.includes('--execute-command-error');

const reader = new StreamMessageReader(process.stdin);
const writer = new StreamMessageWriter(process.stdout);

interface OpenDocument {
  uri: string;
  languageId: string;
  version: number;
  text: string;
}

const openDocuments = new Map<string, OpenDocument>();
/*
 * Client request awaiting the tsserver/response for the bridged request it
 * triggered.
 */
const pendingTsserver = new Map<number, number | string | null>();
const cancellations: unknown[] = [];
const watcherEvents: unknown[] = [];
const configNotifications: unknown[] = [];
const receivedResponses: unknown[] = [];
const state: {
  initializeParams: unknown;
  serverRequestSeq: number;
  tsserverSeq: number;
} = {
  initializeParams: undefined,
  serverRequestSeq: 1000,
  tsserverSeq: 1,
};

const SendTsserverRequestSchema = v.object({ command: v.string(), args: v.unknown() });

/*
 * The real wire shape: the tuple arrives wrapped in the params array.
 */
const TsserverResponseTupleSchema = v.tuple([v.number(), v.unknown()]);

const TsserverResponseSchema = v.pipe(
  v.tuple([TsserverResponseTupleSchema]),
  v.transform(([response]) => response),
);

const respond = (id: number | string | null, result: ResponseMessage['result']): void => {
  const response: ResponseMessage = { jsonrpc: '2.0', id, ...(result !== undefined && { result }) };
  void writer.write(response);
};

const sendNotification = (method: string, params: object): void => {
  void writer.write(createNotification(method, params));
};

const publishDiagnostics = (uri: string): void => {
  sendNotification('textDocument/publishDiagnostics', {
    uri,
    diagnostics: [{
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      message: `${serverName}: opened`,
      source: serverName,
      severity: 3,
    }],
  });
};

const requestHandlers: Record<string, (msg: RequestMessage) => void> = {
  'initialize': (msg) => {
    state.initializeParams = msg.params;
    if (isInitializeError) {
      const failure: ResponseMessage = {
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32_603, message: `${serverName}: initialize failed` },
      };
      void writer.write(failure);
      return;
    }
    respond(msg.id, {
      capabilities: { textDocumentSync: isIncrementalSync ? 2 : 1, hoverProvider: true },
    });
  },
  '$/initParams': (msg) => {
    respond(msg.id, state.initializeParams as object);
  },
  'shutdown': (msg) => {
    /* eslint-disable-next-line unicorn/no-null --
       The JSON-RPC shutdown response result is null. */
    respond(msg.id, null);
  },
  '$/documents': (msg) => {
    respond(msg.id, openDocuments.values().toArray());
  },
  '$/cancellations': (msg) => {
    respond(msg.id, cancellations);
  },
  '$/watcherEvents': (msg) => {
    respond(msg.id, watcherEvents);
  },
  '$/receivedResponses': (msg) => {
    respond(msg.id, receivedResponses);
  },
  '$/configNotifications': (msg) => {
    respond(msg.id, configNotifications);
  },
  '$/unregisterWatchers': (msg) => {
    if (isUnregisterOnCommand) {
      void writer.write(createRequest(state.serverRequestSeq++, 'client/unregisterCapability', {
        unregisterations: [{
          id: `${serverName}-watcher-ts`,
          method: 'workspace/didChangeWatchedFiles',
        }],
      }));
    }
    respond(msg.id, { ok: true });
  },
  /*
   * Stands in for Volar: sends tsserver/request and holds the client's
   * request open until the bridged tsserver/response comes back.
   */
  '$/sendTsserverRequest': (msg) => {
    const { command, args } = v.parse(SendTsserverRequestSchema, msg.params);
    const id = state.tsserverSeq++;
    pendingTsserver.set(id, msg.id);
    sendNotification('tsserver/request', [[id, command, args]]);
  },
  /*
   * Stands in for vtsls, whose typescript.tsserverRequest answers with a body.
   */
  'workspace/executeCommand': (msg) => {
    if (isExecuteCommandError) {
      const failure: ResponseMessage = {
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32_603, message: `${serverName}: command failed` },
      };
      void writer.write(failure);
      return;
    }
    respond(msg.id, { body: { executed: msg.params } });
  },
  'textDocument/diagnostic': (msg) => {
    if (isPullDiagnostics) {
      respond(msg.id, {
        kind: 'full',
        items: [{
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          message: `${serverName}: pull diagnostic`,
          source: serverName,
          severity: 2,
        }],
      });
    } else {
      respond(msg.id, { kind: 'full', items: [] });
    }
  },
};

const handleRequest = (msg: RequestMessage): void => {
  const handler = requestHandlers[msg.method];
  if (handler) {
    handler(msg);
    return;
  }
  respond(msg.id, { echo: msg.method, params: msg.params, server: serverName });
};

const notificationHandlers: Record<string, (msg: NotificationMessage) => void> = {
  'exit': () => {
    /* eslint-disable-next-line unicorn/no-process-exit --
       LSP `exit` means terminate now; the reader keeps the loop alive, so
       process.exitCode wouldn't terminate the subprocess. */
    process.exit(0);
  },
  'initialized': () => {
    if (isRegisterConfig) {
      void writer.write(createRequest(state.serverRequestSeq++, 'client/registerCapability', {
        registrations: [{
          id: `${serverName}-config`,
          method: 'workspace/didChangeConfiguration',
        }],
      }));
    }
    if (isRequestConfig) {
      void writer.write(createRequest(state.serverRequestSeq++, 'workspace/configuration', {
        items: [{ scopeUri: 'file:///test.ts', section: '' }],
      }));
    }
    if (isSendCustomRequest) {
      void writer.write(createRequest(state.serverRequestSeq++, 'window/showMessageRequest', {
        type: 3,
        message: 'Test request from server',
      }));
    }
    if (isRegisterWatchers) {
      void writer.write(createRequest(state.serverRequestSeq++, 'client/registerCapability', {
        registrations: [{
          id: `${serverName}-watcher-ts`,
          method: 'workspace/didChangeWatchedFiles',
          registerOptions: {
            watchers: [{ globPattern: '**/*.ts', kind: 7 }],
          },
        }],
      }));
    }
    if (isRegisterMixed) {
      void writer.write(createRequest(state.serverRequestSeq++, 'client/registerCapability', {
        registrations: [
          {
            id: `${serverName}-watcher-ts`,
            method: 'workspace/didChangeWatchedFiles',
            registerOptions: {
              watchers: [{ globPattern: '**/*.ts', kind: 7 }],
            },
          },
          {
            id: `${serverName}-save`,
            method: 'textDocument/didSave',
            registerOptions: { includeText: true },
          },
        ],
      }));
    }
  },
  'tsserver/response': (msg) => {
    if (!isTsserverClient) return;
    const [id, body] = v.parse(TsserverResponseSchema, msg.params);
    const requestId = pendingTsserver.get(id);
    if (requestId === undefined) return;
    pendingTsserver.delete(id);
    respond(requestId, { id, body });
  },
  '$/cancelRequest': (msg) => {
    cancellations.push(msg.params);
  },
  'workspace/didChangeConfiguration': (msg) => {
    if (isTrackConfig) configNotifications.push(msg.params);
  },
  'workspace/didChangeWatchedFiles': (msg) => {
    watcherEvents.push(msg.params);
  },
  'textDocument/didOpen': (msg) => {
    const { textDocument: td } = v.parse(DidOpenParamsSchema, msg.params);
    openDocuments.set(td.uri, {
      uri: td.uri,
      languageId: td.languageId,
      version: td.version,
      text: td.text,
    });
    publishDiagnostics(td.uri);
  },
  'textDocument/didChange': (msg) => {
    const params = v.parse(DidChangeParamsSchema, msg.params);
    const doc = openDocuments.get(params.textDocument.uri);
    if (doc) {
      doc.version = params.textDocument.version;
      // Apply full-content change (TextDocumentSyncKind.Full)
      const fullChange = params.contentChanges.find(change => change.range === undefined);
      if (fullChange) doc.text = fullChange.text;
    }
  },
  'textDocument/didClose': (msg) => {
    const { textDocument: td } = v.parse(DidCloseParamsSchema, msg.params);
    openDocuments.delete(td.uri);
  },
};

const handleNotification = (msg: NotificationMessage): void => {
  notificationHandlers[msg.method]?.(msg);
};

/* eslint-disable-next-line vitest/require-hook --
   mock-server is a spawned LSP subprocess entry point, not a vitest module;
   the top-level listener is its main loop, not test setup. */
reader.listen((msg) => {
  // Track response messages (for verifying server-to-client routing)
  if (Msg.isResponse(msg)) {
    receivedResponses.push(msg);
    return;
  }

  // Crash on either request or notification form
  if ((Msg.isNotification(msg) || Msg.isRequest(msg)) && msg.method === '$/crash') {
    /* eslint-disable-next-line unicorn/no-process-exit --
       Tests simulate a server crash; the reader keeps the loop alive, so
       process.exitCode wouldn't terminate the subprocess. */
    process.exit(1);
  }

  if (Msg.isRequest(msg)) {
    handleRequest(msg);
    return;
  }

  if (Msg.isNotification(msg)) {
    handleNotification(msg);
  }
});
