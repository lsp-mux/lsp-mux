import type { ChildServer } from './child-server.ts';
import { createNotification } from './types.ts';
import type { ServerConfig, TrackedDocument } from './types.ts';

/** Send the post-initialize notification sequence to a freshly started server. */
export const sendPostInitNotifications = (child: ChildServer, config: ServerConfig): void => {
  child.write(createNotification('initialized', {}));
  if (config.settings) {
    child.write(createNotification('workspace/didChangeConfiguration', {
      settings: config.settings,
    }));
  }
};

/** Replay tracked documents to a (re)started server via textDocument/didOpen. */
export const replayDocuments = (
  child: ChildServer,
  documents: readonly TrackedDocument[],
): void => {
  for (const doc of documents) {
    child.write(createNotification('textDocument/didOpen', {
      textDocument: {
        uri: doc.uri,
        languageId: doc.languageId,
        version: doc.version,
        text: doc.content,
      },
    }));
  }
};
