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
import { StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node.js';
import type { ResponseMessage } from 'vscode-jsonrpc';
import { Message as Msg, createNotification, createRequest } from '../../src/types.js';
import { DidOpenParamsSchema, DidChangeParamsSchema, DidCloseParamsSchema } from '../../src/document-tracker.js';

const serverName = process.argv.find(a => a.startsWith('--name='))?.slice(7) ?? 'mock';
const registerWatchers = process.argv.includes('--register-watchers');
const registerMixed = process.argv.includes('--register-mixed');
const incrementalSync = process.argv.includes('--incremental-sync');
const unregisterOnCommand = process.argv.includes('--unregister-on-command');
const sendCustomRequest = process.argv.includes('--send-custom-request');
const trackConfig = process.argv.includes('--track-config');
const requestConfig = process.argv.includes('--request-config');
const registerConfig = process.argv.includes('--register-config');

const reader = new StreamMessageReader(process.stdin);
const writer = new StreamMessageWriter(process.stdout);

let initializeParams: unknown = null;
const openDocuments = new Map<string, { uri: string; languageId: string; version: number; text: string }>();
const watcherEvents: unknown[] = [];
const configNotifications: unknown[] = [];
const receivedResponses: unknown[] = [];
let serverRequestSeq = 1000;

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

reader.listen((msg) => {
  // Track response messages (for verifying server-to-client routing)
  if (Msg.isResponse(msg)) {
    receivedResponses.push(msg);
    return;
  }

  // Crash on either request or notification form
  if ((Msg.isNotification(msg) || Msg.isRequest(msg)) && msg.method === '$/crash') {
    process.exit(1);
  }

  if (Msg.isRequest(msg)) {
    switch (msg.method) {
      case 'initialize': {
        initializeParams = msg.params;
        respond(msg.id, { capabilities: { textDocumentSync: incrementalSync ? 2 : 1, hoverProvider: true } });
        return;
      }
      case '$/initParams': {
        respond(msg.id, initializeParams as object);
        return;
      }
      case 'shutdown': {
        respond(msg.id, null);
        return;
      }
      case '$/documents': {
        respond(msg.id, [...openDocuments.values()]);
        return;
      }
      case '$/watcherEvents': {
        respond(msg.id, watcherEvents);
        return;
      }
      case '$/receivedResponses': {
        respond(msg.id, receivedResponses);
        return;
      }
      case '$/configNotifications': {
        respond(msg.id, configNotifications);
        return;
      }
      case '$/unregisterWatchers': {
        if (unregisterOnCommand) {
          void writer.write(createRequest(serverRequestSeq++, 'client/unregisterCapability', {
            unregisterations: [{
              id: `${serverName}-watcher-ts`,
              method: 'workspace/didChangeWatchedFiles',
            }],
          }));
        }
        respond(msg.id, { ok: true });
        return;
      }
      default: {
        respond(msg.id, { echo: msg.method, params: msg.params, server: serverName });
        return;
      }
    }
  }

  if (Msg.isNotification(msg)) {
    if (msg.method === 'exit') process.exit(0);

    switch (msg.method) {
      case 'initialized': {
        if (registerConfig) {
          void writer.write(createRequest(serverRequestSeq++, 'client/registerCapability', {
            registrations: [{
              id: `${serverName}-config`,
              method: 'workspace/didChangeConfiguration',
            }],
          }));
        }
        if (requestConfig) {
          void writer.write(createRequest(serverRequestSeq++, 'workspace/configuration', {
            items: [{ scopeUri: 'file:///test.ts', section: '' }],
          }));
        }
        if (sendCustomRequest) {
          void writer.write(createRequest(serverRequestSeq++, 'window/showMessageRequest', {
            type: 3,
            message: 'Test request from server',
          }));
        }
        if (registerWatchers) {
          void writer.write(createRequest(serverRequestSeq++, 'client/registerCapability', {
            registrations: [{
              id: `${serverName}-watcher-ts`,
              method: 'workspace/didChangeWatchedFiles',
              registerOptions: {
                watchers: [{ globPattern: '**/*.ts', kind: 7 }],
              },
            }],
          }));
        }
        if (registerMixed) {
          void writer.write(createRequest(serverRequestSeq++, 'client/registerCapability', {
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
        break;
      }
      case 'workspace/didChangeConfiguration': {
        if (trackConfig) configNotifications.push(msg.params);
        break;
      }
      case 'workspace/didChangeWatchedFiles': {
        watcherEvents.push(msg.params);
        break;
      }
      case 'textDocument/didOpen': {
        const { textDocument: td } = v.parse(DidOpenParamsSchema, msg.params);
        openDocuments.set(td.uri, { uri: td.uri, languageId: td.languageId, version: td.version, text: td.text });
        publishDiagnostics(td.uri);
        break;
      }
      case 'textDocument/didChange': {
        const params = v.parse(DidChangeParamsSchema, msg.params);
        const doc = openDocuments.get(params.textDocument.uri);
        if (doc) {
          doc.version = params.textDocument.version;
          // Apply full-content change (TextDocumentSyncKind.Full)
          const fullChange = params.contentChanges.find(c => c.range === undefined);
          if (fullChange) doc.text = fullChange.text;
        }
        break;
      }
      case 'textDocument/didClose': {
        const { textDocument: td } = v.parse(DidCloseParamsSchema, msg.params);
        openDocuments.delete(td.uri);
        break;
      }
    }
  }
});
