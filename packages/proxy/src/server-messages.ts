/*
 * Server → client message handling: intercepts server-initiated requests
 * the proxy answers itself (capability registration, configuration pulls,
 * diagnostic refresh), forwards the rest, and logs notifications.
 */
import { pathToFileURL } from 'node:url';
import * as v from 'valibot';
import type { DiagnosticsCoordinator } from './diagnostics-coordinator.ts';
import * as fw from './file-watcher.ts';
import type { Logger } from './logger.ts';
import {
  LogMessageSchema,
  RegisterCapabilitySchema,
  UnregisterCapabilitySchema,
  WorkspaceConfigurationSchema,
} from './protocol-schemas.ts';
import { Message as Msg } from './types.ts';
import type {
  Message,
  NotificationMessage,
  RequestMessage,
  ResponseMessage,
  ServerConfig,
} from './types.ts';

/** Proxy internals the server-message handler needs access to. */
export interface ServerMessageDelegate {
  readonly ackToServer: (serverName: string, id: number | string | null) => void;
  readonly getWatchRegistrations: () => fw.WatchRegistrations;
  readonly getWorkspaceRoot: () => string | undefined;
  /** True when compensating for a client without native file watching. */
  readonly isLocalFileWatching: () => boolean;
  readonly sendToServer: (serverName: string, msg: Message) => void;
  readonly setWatchRegistrations: (registrations: fw.WatchRegistrations) => void;
  /** Track a forwarded server request so the client's response routes back. */
  readonly trackServerRequest: (id: number | string | null, serverName: string) => void;
  /** Drop routing state for a client request once its response arrives. */
  readonly untrackClientRequest: (id: number | string) => void;
  readonly writeToClient: (msg: Message) => void;
}

export interface ServerMessageHandler {
  /** Dispatch a message produced by a child server. */
  readonly handleMessage: (serverName: string, msg: Message) => void;
}

export interface CreateServerMessageHandlerOptions {
  delegate: ServerMessageDelegate;
  diagnostics: DiagnosticsCoordinator;
  serverConfigs: ReadonlyMap<string, ServerConfig>;
  log: Logger;
}

export const createServerMessageHandler = ({
  delegate,
  diagnostics,
  serverConfigs,
  log,
}: CreateServerMessageHandlerOptions): ServerMessageHandler => {
  /**
   * Forward server window/logMessage at appropriate level; log others at DEBUG
   * unless the server config declares a custom log level for the notification.
   */
  const logServerNotification = (serverName: string, msg: NotificationMessage): void => {
    if (msg.method === 'window/logMessage') {
      const parsed = v.safeParse(LogMessageSchema, msg.params);
      if (parsed.success) {
        log[parsed.output.type](`${serverName}:`, parsed.output.message);
      }
      return;
    }
    const notifConfig = serverConfigs.get(serverName)?.notifications?.[msg.method];
    if (notifConfig) {
      log[notifConfig.logLevel](`${serverName}:`, msg.method, JSON.stringify(msg.params));
      return;
    }
    log.debug(`${serverName} → proxy: notification ${msg.method}`);
  };

  const logServerMessage = (serverName: string, msg: Message): void => {
    if (Msg.isRequest(msg)) {
      log.debug(`${serverName} → proxy: request ${msg.method}`);
    } else if (Msg.isResponse(msg)) {
      log.debug(`${serverName} → proxy: response (id: ${String(msg.id)})`);
    } else if (Msg.isNotification(msg)) {
      logServerNotification(serverName, msg);
    }
  };

  const handleRegisterCapability = (serverName: string, msg: RequestMessage): void => {
    const parsed = v.safeParse(RegisterCapabilitySchema, msg.params);
    if (!parsed.success) {
      delegate.writeToClient(msg);
      return;
    }

    const otherRegs: typeof parsed.output.registrations = [];
    let handledCount = 0;

    for (const reg of parsed.output.registrations) {
      if (
        reg.method === 'workspace/didChangeWatchedFiles' &&
        delegate.isLocalFileWatching()
      ) {
        const opts = v.safeParse(fw.RegisterOptionsSchema, reg.registerOptions);
        if (opts.success) {
          delegate.setWatchRegistrations(fw.register(
            delegate.getWatchRegistrations(),
            { serverName, registrationId: reg.id },
            opts.output,
            delegate.getWorkspaceRoot(),
          ));
          handledCount++;
          log.info(`${serverName}: registered file watcher ${reg.id}`);
          continue;
        }
        // Malformed watcher registration — log and count as handled (don't forward)
        log.warn(`${serverName}: malformed watcher registration ${reg.id} — skipping`);
        handledCount++;
        continue;
      }
      // The proxy manages config delivery — ack didChangeConfiguration registrations
      // directly so they don't reach the client (which may not support them).
      if (reg.method === 'workspace/didChangeConfiguration') {
        handledCount++;
        continue;
      }
      otherRegs.push(reg);
    }

    if (otherRegs.length > 0) {
      // Forward non-watcher registrations to client, track for response routing
      const filtered: RequestMessage = { ...msg, params: { registrations: otherRegs } };
      delegate.trackServerRequest(msg.id, serverName);
      delegate.writeToClient(filtered);
    } else if (handledCount > 0) {
      // All registrations were file watchers — ack to server directly
      delegate.ackToServer(serverName, msg.id);
    } else {
      // Nothing matched — forward original
      delegate.writeToClient(msg);
    }
  };

  const handleUnregisterCapability = (serverName: string, msg: RequestMessage): void => {
    const parsed = v.safeParse(UnregisterCapabilitySchema, msg.params);
    if (!parsed.success) {
      delegate.writeToClient(msg);
      return;
    }

    // LSP spec misspells "unregisterations" (sic)
    const otherUnregs: typeof parsed.output.unregisterations = [];
    let handledCount = 0;

    for (const unreg of parsed.output.unregisterations) {
      if (
        unreg.method === 'workspace/didChangeWatchedFiles' &&
        delegate.isLocalFileWatching()
      ) {
        delegate.setWatchRegistrations(
          fw.unregister(delegate.getWatchRegistrations(), unreg.id),
        );
        handledCount++;
        log.info(`${serverName}: unregistered file watcher ${unreg.id}`);
      } else {
        otherUnregs.push(unreg);
      }
    }

    if (otherUnregs.length > 0) {
      const filtered: RequestMessage = { ...msg, params: { unregisterations: otherUnregs } };
      delegate.trackServerRequest(msg.id, serverName);
      delegate.writeToClient(filtered);
    } else if (handledCount > 0) {
      delegate.ackToServer(serverName, msg.id);
    } else {
      delegate.writeToClient(msg);
    }
  };

  const handleWorkspaceConfiguration = (
    serverName: string,
    msg: RequestMessage,
    settings: Record<string, unknown>,
  ): void => {
    const parsed = v.safeParse(WorkspaceConfigurationSchema, msg.params);
    if (!parsed.success) {
      log.warn(
        `${serverName}: malformed workspace/configuration request — responding with empty array`,
      );
      const response: ResponseMessage = { jsonrpc: '2.0', id: msg.id, result: [] };
      delegate.sendToServer(serverName, response);
      return;
    }

    const workspaceRoot = delegate.getWorkspaceRoot();
    const workspaceFolder = workspaceRoot
      ? { uri: pathToFileURL(workspaceRoot).href, name: '' }
      : undefined;

    const result = parsed.output.items.map((item) => {
      const section = item.section;
      if (section && Object.hasOwn(settings, section)) return settings[section];
      return { ...settings, workspaceFolder };
    });

    const response: ResponseMessage = { jsonrpc: '2.0', id: msg.id, result };
    delegate.sendToServer(serverName, response);
  };

  /** Clean up routing state and forward a server message to the client. */
  const forwardServerMessage = (serverName: string, msg: Message): void => {
    if (Msg.isResponse(msg) && msg.id !== null) {
      delegate.untrackClientRequest(msg.id);
    }
    // Track server-to-client requests so the client's response can be routed back
    if (Msg.isRequest(msg)) {
      delegate.trackServerRequest(msg.id, serverName);
    }
    delegate.writeToClient(msg);
  };

  /*
   * Server-initiated requests the proxy intercepts and answers itself.
   * Anything not listed here is forwarded to the client.
   */
  const interceptedRequestHandlers: Record<
    string,
    (serverName: string, msg: RequestMessage) => void
  > = {
    'client/registerCapability': handleRegisterCapability,
    'client/unregisterCapability': handleUnregisterCapability,
    'workspace/configuration': (serverName, msg) => {
      const settings = serverConfigs.get(serverName)?.settings;
      if (settings) {
        handleWorkspaceConfiguration(serverName, msg, settings);
      } else {
        // No settings configured — forward to the client like any other request
        forwardServerMessage(serverName, msg);
      }
    },
    'workspace/diagnostic/refresh': (serverName, msg) => {
      diagnostics.handleRefresh(serverName, msg);
    },
  };

  return {
    handleMessage(serverName, msg) {
      logServerMessage(serverName, msg);
      if (diagnostics.handlePublish(serverName, msg)) return;
      if (Msg.isRequest(msg)) {
        const handler = interceptedRequestHandlers[msg.method];
        if (handler) {
          handler(serverName, msg);
          return;
        }
      }
      forwardServerMessage(serverName, msg);
    },
  };
};
