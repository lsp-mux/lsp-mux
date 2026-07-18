/*
 * Pure rewrite helpers for document sync notifications. The proxy applies
 * these before fanning a notification out to child servers; spreads create
 * new objects, so the original message is never mutated.
 */
import { isPlainObject } from './capabilities.ts';
import { createNotification } from './types.ts';
import type { Message, NotificationMessage } from './types.ts';

/**
 * Rewrite the textDocument.uri in a document sync notification to a
 * normalized form. Used when the client sends non-standard file URIs.
 */
export const rewriteDocSyncUri = (
  msg: NotificationMessage,
  normalizedUri: string,
): NotificationMessage => {
  const params = msg.params;
  if (!isPlainObject(params)) return msg;
  const td = params['textDocument'];
  if (!isPlainObject(td)) return msg;
  return createNotification(msg.method, {
    ...params,
    textDocument: { ...td, uri: normalizedUri },
  });
};

/**
 * Rewrite the textDocument.version in a document sync notification by the
 * given version offset (from a prior resync).
 */
export const rewriteDocSyncVersion = (msg: NotificationMessage, offset: number): Message => {
  const params = msg.params;
  if (!isPlainObject(params)) return msg;
  const td = params['textDocument'];
  if (!isPlainObject(td) || typeof td['version'] !== 'number') return msg;
  return createNotification(msg.method, {
    ...params,
    textDocument: { ...td, version: td['version'] + offset },
  });
};
