// Message is both an interface and a namespace (with isRequest/isResponse/isNotification guards)
export { Message } from 'vscode-jsonrpc';
export type { RequestMessage, ResponseMessage, NotificationMessage } from 'vscode-jsonrpc';
import type { RequestMessage, NotificationMessage } from 'vscode-jsonrpc';

// --- Server & proxy configuration ---

export { ServerConfigSchema, ProxyConfigSchema } from './config-schema.js';
export type { ServerConfig, ProxyConfig } from './config-schema.js';

// --- Document tracking ---

export interface TrackedDocument {
  readonly uri: string;
  readonly languageId: string;
  readonly version: number;
  readonly content: string;
}

// --- Message factories (avoid `as Message` casts on object literals) ---

export const createRequest = (
  id: number | string,
  method: string,
  params?: RequestMessage['params'],
): RequestMessage => ({ jsonrpc: '2.0', id, method, ...(params && { params }) });

export const createNotification = (
  method: string,
  params?: NotificationMessage['params'],
): NotificationMessage => ({ jsonrpc: '2.0', method, ...(params && { params }) });

// --- Constants ---

/** Notifications that mutate document state — tracked by the proxy, not buffered during restart. */
export const DOCUMENT_SYNC_METHODS = new Set([
  'textDocument/didOpen',
  'textDocument/didChange',
  'textDocument/didClose',
]);

export const LSP_ERROR_CODES = {
  ServerNotInitialized: -32002,
  RequestCancelled: -32800,
  InternalError: -32603,
} as const;
