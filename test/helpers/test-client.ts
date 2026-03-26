import { StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node.js';
import type { Message } from 'vscode-jsonrpc';
import { Message as Msg, createRequest, createNotification } from '../../src/types.js';

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
      if (predicate(msg)) {
        clearTimeout(timer);
        disposable.dispose();
        resolve(msg);
      }
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
      if (predicate(msg)) {
        collected.push(msg);
        if (collected.length >= count) {
          clearTimeout(timer);
          disposable.dispose();
          resolve(collected);
        }
      }
    });
  });

/** Send a request and wait for the matching response. */
export const request = async (
  writer: StreamMessageWriter,
  reader: StreamMessageReader,
  id: number,
  method: string,
  params?: object,
): Promise<Message> => {
  const promise = waitForMessage(reader, msg => Msg.isResponse(msg) && msg.id === id);
  await writer.write(createRequest(id, method, params));
  return promise;
};

/** Send a notification (fire and forget). */
export const notify = async (writer: StreamMessageWriter, method: string, params?: object): Promise<void> => {
  await writer.write(createNotification(method, params));
};

/** Perform the full initialize handshake. */
export const initializeProxy = async (
  writer: StreamMessageWriter,
  reader: StreamMessageReader,
): Promise<Message> => {
  const res = await request(writer, reader, 0, 'initialize', {
    processId: process.pid,
    rootUri: null,
    capabilities: {},
  });
  await notify(writer, 'initialized', {});
  return res;
};
