/**
 * Minimal mock LSP server for integration tests.
 * Reads JSON-RPC from stdin, responds to initialize, echoes everything else.
 * Tracks open documents so tests can verify replay after restart.
 * Exits on "exit" notification or SIGTERM.
 */
import * as v from 'valibot';
import { StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node.js';
import type { ResponseMessage } from 'vscode-jsonrpc';
import { Message as Msg } from '../../src/types.js';
import { DidOpenParamsSchema, DidChangeParamsSchema, DidCloseParamsSchema } from '../../src/document-tracker.js';

const reader = new StreamMessageReader(process.stdin);
const writer = new StreamMessageWriter(process.stdout);

const openDocuments = new Map<string, { uri: string; languageId: string; version: number }>();

const respond = (id: number | string | null, result: ResponseMessage['result']): void => {
  const response: ResponseMessage = { jsonrpc: '2.0', id, ...(result !== undefined && { result }) };
  writer.write(response);
};

reader.listen((msg) => {
  // Crash on either request or notification form
  if ((Msg.isNotification(msg) || Msg.isRequest(msg)) && msg.method === '$/crash') {
    process.exit(1);
  }

  if (Msg.isRequest(msg)) {
    switch (msg.method) {
      case 'initialize':
        return respond(msg.id, { capabilities: { textDocumentSync: 1, hoverProvider: true } });
      case 'shutdown':
        return respond(msg.id, null);
      case '$/documents':
        return respond(msg.id, [...openDocuments.values()]);
      default:
        return respond(msg.id, { echo: msg.method, params: msg.params });
    }
  }

  if (Msg.isNotification(msg)) {
    if (msg.method === 'exit') process.exit(0);

    switch (msg.method) {
      case 'textDocument/didOpen': {
        const { textDocument: td } = v.parse(DidOpenParamsSchema, msg.params);
        openDocuments.set(td.uri, { uri: td.uri, languageId: td.languageId, version: td.version });
        break;
      }
      case 'textDocument/didChange': {
        const { textDocument: td } = v.parse(DidChangeParamsSchema, msg.params);
        const doc = openDocuments.get(td.uri);
        if (doc) doc.version = td.version;
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
