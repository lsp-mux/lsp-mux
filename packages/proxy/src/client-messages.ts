/*
 * Client → server message handling: the proxy-state dispatch for messages
 * arriving from the editor — document sync fan-out, request routing to the
 * primary server, cancellation, and lifecycle notifications.
 */
import * as v from 'valibot';
import type { DiagnosticsCoordinator } from './diagnostics-coordinator.ts';
import { rewriteDocSyncUri, rewriteDocSyncVersion } from './doc-sync.ts';
import type { Logger } from './logger.ts';
import type { ManagedServer } from './managed-server.ts';
import { CancelParamsSchema } from './protocol-schemas.ts';
import type { Router } from './router.ts';
import { extractUri } from './router.ts';
import { Message as Msg, documentSyncMethods, lspErrorCodes } from './types.ts';
import type { Message, NotificationMessage, RequestMessage, ResponseMessage } from './types.ts';
import { normalizeFileUri } from './uri.ts';

export type ProxyState = 'idle' | 'running' | 'stopped';

/** Proxy internals the client-message handler needs access to. */
export interface ClientMessageDelegate {
  /** Track a document sync notification in the proxy's document state. */
  readonly applyDocumentSync: (method: string, params: NotificationMessage['params']) => void;
  /** Shut the whole proxy down (client sent exit while running). */
  readonly dispose: () => void;
  /** Stop reading client input (client sent exit after shutdown). */
  readonly disposeReader: () => void;
  readonly getState: () => ProxyState;
  /** Begin the initialize handshake for all servers. */
  readonly initializeServers: (
    id: number | string | null,
    params: RequestMessage['params'],
  ) => void;
  readonly sendErrorToClient: (id: number | string | null, code: number, message: string) => void;
  /** Coordinate shutdown across all servers and respond to the client. */
  readonly shutdownServers: (id: number | string | null) => void;
}

export interface ClientMessageHandler {
  /** Dispatch a message received from the client. */
  readonly handleMessage: (msg: Message) => void;
}

export interface CreateClientMessageHandlerOptions {
  delegate: ClientMessageDelegate;
  diagnostics: DiagnosticsCoordinator;
  log: Logger;
  /** Server owning each pending client request (shared, used for cancel routing). */
  requestRouting: Map<number | string | null, string>;
  router: Router;
  /** Server that originated each server-to-client request (shared). */
  serverRequestRouting: Map<number | string | null, string>;
  servers: ReadonlyMap<string, ManagedServer>;
  /** Per-document resync version offsets (shared with the proxy's watcher). */
  versionOffsets: Map<string, number>;
}

export const createClientMessageHandler = ({
  delegate,
  diagnostics,
  log,
  requestRouting,
  router,
  serverRequestRouting,
  servers,
  versionOffsets,
}: CreateClientMessageHandlerOptions): ClientMessageHandler => {
  const logClientMessage = (msg: Message): void => {
    if (Msg.isRequest(msg)) {
      log.debug(`client → proxy: request ${msg.method} (id: ${String(msg.id)})`);
    } else if (Msg.isNotification(msg)) {
      log.debug(`client → proxy: notification ${msg.method}`);
    } else if (Msg.isResponse(msg)) {
      log.debug(`client → proxy: response (id: ${String(msg.id)})`);
    }
  };

  /** Broadcast a message to every server that isn't idle. */
  const broadcastToActive = (msg: Message): void => {
    for (const server of servers.values()) {
      if (server.state !== 'idle') server.send(msg);
    }
  };

  /** Route a client response back to the server that issued the request. */
  const routeClientResponse = (msg: ResponseMessage): void => {
    const targetServer = serverRequestRouting.get(msg.id);
    serverRequestRouting.delete(msg.id);
    if (targetServer) {
      servers.get(targetServer)?.send(msg);
    }
  };

  const handleCancelRequest = (msg: NotificationMessage): void => {
    const result = v.safeParse(CancelParamsSchema, msg.params);
    if (result.success) {
      const { id } = result.output;
      let isCancelled = false;
      for (const server of servers.values()) {
        if (server.cancelBuffered(id)) isCancelled = true;
      }
      if (isCancelled) {
        delegate.sendErrorToClient(id, lspErrorCodes.RequestCancelled, 'Request cancelled');
        requestRouting.delete(id);
        return;
      }
    }
    // Not buffered — forward for in-flight cancellation (skip idle servers)
    broadcastToActive(msg);
  };

  /** Apply this document's resync version offset to a sync notification, if any. */
  const applyVersionOffset = (msg: NotificationMessage, uri: string | undefined): Message => {
    const offset = uri ? versionOffsets.get(uri) : undefined;
    return offset ? rewriteDocSyncVersion(msg, offset) : msg;
  };

  const handleDocumentSync = (msg: NotificationMessage): void => {
    const rawUri = extractUri(msg);
    const uri = rawUri ? normalizeFileUri(rawUri) : undefined;
    const normalized = uri && uri !== rawUri
      ? rewriteDocSyncUri(msg, uri)
      : msg;

    // Reset version offset on open/close — client version is authoritative
    const isOpenOrClose =
      msg.method === 'textDocument/didOpen' || msg.method === 'textDocument/didClose';
    if (isOpenOrClose && uri) versionOffsets.delete(uri);

    const rewritten = applyVersionOffset(normalized, uri);
    for (const name of router.serversForUri(uri)) {
      servers.get(name)?.send(rewritten);
    }

    diagnostics.maybePullAfterSync(msg, uri);
  };

  const handleRunningNotification = (msg: NotificationMessage): void => {
    switch (msg.method) {
      case 'exit': {
        broadcastToActive(msg);
        delegate.dispose();
        return;
      }
      case 'initialized': {
        for (const server of servers.values()) server.sendInitialized();
        log.info('LSP handshake complete');
        return;
      }
      case '$/cancelRequest': {
        handleCancelRequest(msg);
        return;
      }
    }
    if (documentSyncMethods.has(msg.method)) {
      handleDocumentSync(msg);
      return;
    }
    broadcastToActive(msg);
  };

  /** Route a generic client request to the primary server for its document. */
  const routeRequestToPrimary = (msg: RequestMessage): void => {
    const uri = extractUri(msg);
    const primaryName = router.primaryForUri(uri);
    const primary = primaryName ? servers.get(primaryName) : undefined;
    if (primary) {
      requestRouting.set(msg.id, primary.name);
      if (!primary.send(msg)) {
        delegate.sendErrorToClient(msg.id, lspErrorCodes.InternalError, 'Server unavailable');
        requestRouting.delete(msg.id);
      }
    } else {
      delegate.sendErrorToClient(msg.id, lspErrorCodes.InternalError, 'No servers available');
    }
  };

  const handleRunningRequest = (msg: RequestMessage): void => {
    switch (msg.method) {
      case 'shutdown': {
        delegate.shutdownServers(msg.id);
        return;
      }
      case 'textDocument/diagnostic': {
        void diagnostics.handleClientPull(msg);
        return;
      }
    }
    routeRequestToPrimary(msg);
  };

  const handleRunningMessage = (msg: Message): void => {
    if (Msg.isResponse(msg)) {
      routeClientResponse(msg);
      return;
    }
    if (Msg.isNotification(msg)) {
      handleRunningNotification(msg);
      return;
    }
    if (Msg.isRequest(msg)) {
      handleRunningRequest(msg);
    }
  };

  const handleIdleMessage = (msg: Message): void => {
    if (Msg.isRequest(msg) && msg.method === 'initialize') {
      delegate.initializeServers(msg.id, msg.params);
      return;
    }
    if (Msg.isRequest(msg)) {
      delegate.sendErrorToClient(msg.id, lspErrorCodes.ServerNotInitialized, 'Not initialized');
    }
  };

  const handleStoppedMessage = (msg: Message): void => {
    if (Msg.isNotification(msg) && msg.method === 'exit') {
      delegate.disposeReader();
      return;
    }
    if (Msg.isRequest(msg)) {
      delegate.sendErrorToClient(msg.id, lspErrorCodes.ServerNotInitialized, 'Server stopped');
    }
  };

  return {
    handleMessage(msg) {
      logClientMessage(msg);

      if (Msg.isNotification(msg) && documentSyncMethods.has(msg.method)) {
        delegate.applyDocumentSync(msg.method, msg.params);
      }

      switch (delegate.getState()) {
        case 'idle': {
          handleIdleMessage(msg);
          return;
        }
        case 'running': {
          handleRunningMessage(msg);
          return;
        }
        case 'stopped': {
          handleStoppedMessage(msg);
          return;
        }
      }
    },
  };
};
