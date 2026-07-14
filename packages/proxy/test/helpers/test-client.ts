import type { Message, ResponseMessage } from 'vscode-jsonrpc';
import { StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node.js';
import { Message as Msg, createNotification, createRequest } from '../../src/types.ts';

/** Collect messages from a reader until a predicate matches. */
export const waitForMessage = (
  reader: StreamMessageReader,
  predicate: (msg: Message) => boolean,
  timeoutMs = 10_000,
): Promise<Message> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => { reject(new Error('Timeout waiting for message')); },
      timeoutMs,
    );
    const disposable = reader.listen((msg) => {
      if (!predicate(msg)) {
      	return;
      }

      clearTimeout(timer);
      disposable.dispose();
      resolve(msg);
    });
  });

/** Collect N messages matching a predicate. */
export const collectMessages = (
  reader: StreamMessageReader,
  predicate: (msg: Message) => boolean,
  count: number,
  timeoutMs = 10_000,
): Promise<Message[]> =>
  new Promise((resolve, reject) => {
    const collected: Message[] = [];
    const timer = setTimeout(
      () => { reject(new Error(`Timeout: collected ${String(collected.length)}/${String(count)} messages`)); },
      timeoutMs,
    );
    const disposable = reader.listen((msg) => {
      if (!predicate(msg)) {
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

/** Send a request and wait for the matching response. */
export const request = (
  writer: StreamMessageWriter,
  reader: StreamMessageReader,
  id: number,
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

/** Send a notification (fire and forget). */
export const notify = async (writer: StreamMessageWriter, method: string, params?: object): Promise<void> => {
  await writer.write(createNotification(method, params));
};

/** Perform the full initialize handshake. */
export const initializeProxy = async (
  writer: StreamMessageWriter,
  reader: StreamMessageReader,
  rootUri: string | null = null,
  capabilities: object = {},
): Promise<Message> => {
  const res = await request(writer, reader, 0, 'initialize', {
    processId: process.pid,
    rootUri,
    capabilities,
  });
  await notify(writer, 'initialized', {});
  return res;
};
