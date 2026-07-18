import * as v from 'valibot';
import { isPlainObject } from './capabilities.ts';
import * as diag from './diagnostics-store.ts';
import type { Logger } from './logger.ts';
import type { ManagedServer } from './managed-server.ts';
import { PublishDiagnosticsSchema } from './protocol-schemas.ts';
import { extractUri } from './router.ts';
import { Message as Msg, createNotification } from './types.ts';
import type { Message, NotificationMessage, RequestMessage, ResponseMessage } from './types.ts';
import { normalizeFileUri } from './uri.ts';

// Grace period before proactively pulling diagnostics from servers that are
// still starting on the first didOpen, giving them time to come up.
const lazyStartPullDiagnosticsDelayMs = 3000;

/** Proxy internals the diagnostics coordinator needs access to. */
export interface DiagnosticsDelegate {
  /** Servers matched to a document URI, in routing order. */
  readonly serversForUri: (uri: string | undefined) => readonly string[];
  readonly getServer: (name: string) => ManagedServer | undefined;
  readonly isStopped: () => boolean;
  /** True when compensating for a client without native pull-diagnostic support. */
  readonly isProactivePull: () => boolean;
  /** URIs of all currently tracked (open) documents. */
  readonly getTrackedUris: () => Iterable<string>;
  readonly writeToClient: (msg: Message) => void;
  readonly respondToClient: (id: number | string | null, result: ResponseMessage['result']) => void;
  readonly ackToServer: (serverName: string, id: number | string | null) => void;
  /** Track a forwarded server request so the client's response routes back. */
  readonly trackServerRequest: (id: number | string | null, serverName: string) => void;
}

/**
 * Owns the merged diagnostics store: republishes pushed diagnostics,
 * fans out pull requests, and compensates for clients without native
 * pull-diagnostic support.
 */
export interface DiagnosticsCoordinator {
  /** Store + republish pushed diagnostics. Returns true if the message was consumed. */
  readonly handlePublish: (serverName: string, msg: Message) => boolean;
  /**
   * workspace/diagnostic/refresh: when compensating, re-pull diagnostics for
   * tracked documents; otherwise forward to the client so it re-pulls.
   */
  readonly handleRefresh: (serverName: string, msg: RequestMessage) => void;
  /** Fan out textDocument/diagnostic to all matching servers and merge results. */
  readonly handleClientPull: (msg: RequestMessage) => Promise<void>;
  /**
   * Proactively pull diagnostics after a document sync when compensating for a
   * client without native pull support. Servers still starting are polled
   * after a grace delay so they have time to come up.
   */
  readonly maybePullAfterSync: (msg: NotificationMessage, uri: string | undefined) => void;
  /** Drop a (re)starting server's diagnostics and republish affected URIs. */
  readonly clearServer: (serverName: string) => void;
}

export const createDiagnosticsCoordinator = (
  delegate: DiagnosticsDelegate,
  log: Logger,
): DiagnosticsCoordinator => {
  let store: diag.DiagnosticsStore = diag.empty();

  const publishMerged = (uri: string): void => {
    const merged = diag.merge(store, uri);
    log.debug(`Publishing ${String(merged.length)} merged diagnostics for ${uri}`);
    delegate.writeToClient(createNotification('textDocument/publishDiagnostics', {
      uri,
      diagnostics: merged,
    }));
  };

  const requestDiagnostics = (
    uri: string,
  ): Promise<{ name: string; res: ResponseMessage }[]> => {
    const params = { textDocument: { uri } };
    return Promise.all(
      delegate.serversForUri(uri)
        .map(name => delegate.getServer(name))
        .filter(server => server !== undefined)
        .map(async (server) => {
          const res = await server.sendRequest('textDocument/diagnostic', params);
          return { name: server.name, res };
        }),
    );
  };

  /**
   * Pull diagnostics from all matching servers and store results.
   * Only publishes if at least one server returns items — avoids
   * spurious re-publications that race with push-based servers.
   */
  const pull = async (uri: string): Promise<void> => {
    const responses = await requestDiagnostics(uri);

    let isUpdated = false;
    for (const { name, res } of responses) {
      if (!res.result || !isPlainObject(res.result)) continue;
      const items = res.result['items'];
      if (!Array.isArray(items)) continue;
      store = diag.update(store, name, uri, items);
      isUpdated = true;
    }

    if (isUpdated) {
      publishMerged(uri);
    }
  };

  return {
    handlePublish(serverName, msg) {
      if (!(Msg.isNotification(msg) && msg.method === 'textDocument/publishDiagnostics')) {
        return false;
      }
      const result = v.safeParse(PublishDiagnosticsSchema, msg.params);
      if (!result.success) return false;
      const uri = normalizeFileUri(result.output.uri);
      store = diag.update(store, serverName, uri, result.output.diagnostics);
      publishMerged(uri);
      return true;
    },

    handleRefresh(serverName, msg) {
      if (delegate.isProactivePull()) {
        delegate.ackToServer(serverName, msg.id);
        for (const uri of delegate.getTrackedUris()) {
          void pull(uri);
        }
        return;
      }
      // Forward to client — track for response routing
      delegate.trackServerRequest(msg.id, serverName);
      delegate.writeToClient(msg);
    },

    async handleClientPull(msg) {
      const uri = extractUri(msg);
      const serverNames = delegate.serversForUri(uri);

      const requests = serverNames
        .map(name => delegate.getServer(name))
        .filter(server => server !== undefined)
        .map(server => server.sendRequest('textDocument/diagnostic', msg.params));

      const responses = await Promise.all(requests);

      const allItems: unknown[] = [];
      for (const res of responses) {
        if (!res.result || !isPlainObject(res.result)) continue;
        const items = res.result['items'];
        if (Array.isArray(items)) {
          for (const item of items) allItems.push(item);
        }
      }

      delegate.respondToClient(msg.id, { kind: 'full', items: allItems });
    },

    maybePullAfterSync(msg, uri) {
      if (
        !delegate.isProactivePull() ||
        uri === undefined ||
        msg.method === 'textDocument/didClose'
      ) {
        return;
      }
      const isAllStarting = delegate.serversForUri(uri)
        .every((serverName) => {
          const state = delegate.getServer(serverName)?.state;
          return state === 'starting' || state === 'idle';
        });
      if (isAllStarting) {
        setTimeout(() => {
          if (delegate.isStopped()) return;
          void pull(uri);
        }, lazyStartPullDiagnosticsDelayMs);
      } else {
        void pull(uri);
      }
    },

    clearServer(serverName) {
      const { store: next, affectedUris } = diag.clearServer(store, serverName);
      store = next;
      for (const uri of affectedUris) publishMerged(uri);
    },
  };
};
