import { StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node.js';
import { createRequest, createNotification } from '../../src/types.js';

/** Collect messages from a reader until a predicate matches. */
export const waitForMessage = (
  reader: StreamMessageReader,
  predicate: (msg: any) => boolean,
  timeoutMs = 10_000,
): Promise<any> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Timeout waiting for message')),
      timeoutMs,
    );
    const disposable = reader.listen((msg: any) => {
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
  predicate: (msg: any) => boolean,
  count: number,
  timeoutMs = 10_000,
): Promise<any[]> =>
  new Promise((resolve, reject) => {
    const collected: any[] = [];
    const timer = setTimeout(
      () => reject(new Error(`Timeout: collected ${collected.length}/${count} messages`)),
      timeoutMs,
    );
    const disposable = reader.listen((msg: any) => {
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
export const request = (
  writer: StreamMessageWriter,
  reader: StreamMessageReader,
  id: number,
  method: string,
  params?: object,
): Promise<any> => {
  const promise = waitForMessage(reader, (msg) => msg.id === id && !msg.method);
  writer.write(createRequest(id, method, params));
  return promise;
};

/** Send a notification (fire and forget). */
export const notify = (writer: StreamMessageWriter, method: string, params?: object): void => {
  writer.write(createNotification(method, params));
};

/** Perform the full initialize handshake. */
export const initializeProxy = async (
  writer: StreamMessageWriter,
  reader: StreamMessageReader,
) => {
  const res = await request(writer, reader, 0, 'initialize', {
    processId: process.pid,
    rootUri: null,
    capabilities: {},
  });
  notify(writer, 'initialized', {});
  return res;
};
