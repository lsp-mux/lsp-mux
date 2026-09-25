/*
 * Per-document version offsets. A resync rewrites a document the client never
 * touched, so the version the servers see has to keep climbing while the
 * client's stays where the client left it. The offset is the distance between
 * the two, added on the way out to a server.
 */
import * as docs from './document-tracker.ts';
import { createNotification } from './types.ts';
import type { NotificationMessage, TrackedDocument } from './types.ts';

/**
 * How far ahead of the client each document's server-visible version runs.
 */
export type VersionOffsets = ReadonlyMap<string, number>;

/**
 * A resynced document: the tracked state to keep, the offset it now carries,
 * and the change to send the servers holding it.
 */
export interface Resync {
  readonly documents: docs.DocumentMap;
  readonly notification: NotificationMessage;
  readonly offset: number;
}

export interface ResyncRequest {
  /**
   * The version the client last set, which a resync leaves where it is.
   */
  readonly clientVersion: number;
  readonly documents: docs.DocumentMap;
  readonly offsets: VersionOffsets;
  readonly text: string;
  readonly uri: string;
}

/**
 * Resync one document to `text`, read from disk rather than sent by the
 * client. The offset advances by one, which is what keeps the server version
 * ahead of the client version it is derived from.
 */
export const resync = (
  { clientVersion, documents, offsets, text, uri }: ResyncRequest,
): Resync => {
  const offset = (offsets.get(uri) ?? 0) + 1;
  return {
    documents: docs.trackChange(documents, {
      textDocument: { uri, version: clientVersion },
      contentChanges: [{ text }],
    }),
    notification: createNotification('textDocument/didChange', {
      textDocument: { uri, version: clientVersion + offset },
      contentChanges: [{ text }],
    }),
    offset,
  };
};

/**
 * Every tracked document at the version the servers have seen, which is what a
 * server restarting has to be replayed at.
 */
export const applyToDocuments = (
  documents: docs.DocumentMap,
  offsets: VersionOffsets,
): readonly TrackedDocument[] =>
  docs.toArray(documents).map((doc) => {
    const offset = offsets.get(doc.uri) ?? 0;
    return offset > 0 ? { ...doc, version: doc.version + offset } : doc;
  });
