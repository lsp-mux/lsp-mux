import { faker } from '@faker-js/faker';
import * as v from 'valibot';
import type { Message, NotificationMessage, ResponseMessage } from 'vscode-jsonrpc';
import { StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node.js';
import { Message as Msg, createNotification, createRequest } from '../../src/types.ts';
import { fakeUri } from './fake.ts';

/**
 * Collect messages from a reader until a predicate matches.
 */
export const waitForMessage = (
  reader: StreamMessageReader,
  isMatch: (msg: Message) => boolean,
  timeoutMs = 10_000,
): Promise<Message> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => { reject(new Error('Timeout waiting for message')); },
      timeoutMs,
    );
    const disposable = reader.listen((msg) => {
      if (!isMatch(msg)) {
        return;
      }

      clearTimeout(timer);
      disposable.dispose();
      resolve(msg);
    });
  });

const DiagnosticSourceSchema = v.object({ source: v.optional(v.string()) });

const PublishedSourcesSchema = v.object({
  diagnostics: v.array(DiagnosticSourceSchema),
});

/**
 * The sources a publish carries, which is what distinguishes one publish from
 * the next when reading back why a collector gave up.
 */
const describeSources = (params: NotificationMessage['params']): string => {
  const parsed = v.safeParse(PublishedSourcesSchema, params);
  if (!parsed.success) return 'unparsed';
  return parsed.output.diagnostics.map(diag => diag.source ?? 'unnamed').join('+');
};

/**
 * One-line identification of a message, for timeout diagnostics.
 */
const describeMessage = (msg: Message): string => {
  if (Msg.isRequest(msg)) return `request ${msg.method} (${String(msg.id)})`;
  if (Msg.isNotification(msg)) {
    return msg.method === 'textDocument/publishDiagnostics'
      ? `publishDiagnostics [${describeSources(msg.params)}]`
      : `notification ${msg.method}`;
  }
  if (Msg.isResponse(msg)) return `response (${String(msg.id)})`;
  return 'unknown';
};

/**
 * Collect N messages matching a predicate.
 */
export const collectMessages = (
  reader: StreamMessageReader,
  isMatch: (msg: Message) => boolean,
  count: number,
  timeoutMs = 10_000,
): Promise<Message[]> =>
  new Promise((resolve, reject) => {
    const collected: Message[] = [];
    const seen: string[] = [];
    const timer = setTimeout(
      () => {
        reject(new Error(
          `Timeout: collected ${String(collected.length)}/${String(count)} messages. ` +
          `Reader saw: ${seen.join(', ')}`,
        ));
      },
      timeoutMs,
    );
    const disposable = reader.listen((msg) => {
      seen.push(describeMessage(msg));
      if (!isMatch(msg)) {
        return;
      }

      collected.push(msg);
      if (collected.length >= count) {
        clearTimeout(timer);
        disposable.dispose();
        resolve(collected);
      }
    });
  });

/**
 * The proxy's client-side JSON-RPC stream pair.
 */
export interface Client {
  writer: StreamMessageWriter;
  reader: StreamMessageReader;
}

/**
 * Send a request and wait for the matching response.
 */
export const request = (
  { writer, reader }: Client,
  id: number | string,
  method: string,
  params?: object,
): Promise<ResponseMessage> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => { reject(new Error('Timeout waiting for response')); },
      10_000,
    );
    const disposable = reader.listen((msg) => {
      if (!(Msg.isResponse(msg) && msg.id === id)) {
        return;
      }

      clearTimeout(timer);
      disposable.dispose();
      resolve(msg);
    });
    void writer.write(createRequest(id, method, params));
  });

/**
 * Send a notification (fire and forget).
 */
export const notify = async (
  writer: StreamMessageWriter,
  method: string,
  params?: object,
): Promise<void> => {
  await writer.write(createNotification(method, params));
};

/**
 * Open a throwaway TypeScript document (e.g. to trigger lazy server start).
 * Override uri/text/version when the test cares about the content.
 */
export const openDocument = (
  writer: StreamMessageWriter,
  overrides: { uri?: string; text?: string; version?: number } = {},
): Promise<void> =>
  notify(writer, 'textDocument/didOpen', {
    textDocument: {
      uri: overrides.uri ?? fakeUri(),
      languageId: 'typescript',
      version: overrides.version ?? 1,
      text: overrides.text ?? faker.lorem.word(),
    },
  });

/**
 * Perform the full initialize handshake.
 */
export const initializeProxy = async (
  client: Client,
  /* eslint-disable-next-line unicorn/no-null --
     LSP InitializeParams.rootUri is `string | null`; null means no root. */
  rootUri: string | null = null,
  capabilities: object = {},
): Promise<Message> => {
  const res = await request(client, 0, 'initialize', {
    processId: process.pid,
    rootUri,
    capabilities,
  });
  await notify(client.writer, 'initialized', {});
  return res;
};
