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

// --- Timer abstraction ---

// Method syntax is intentional: bivariant parameter checking allows
// sinon's Clock (clearTimeout(id: number)) to satisfy clearTimeout(id: unknown).
export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

export const defaultTimers: Timers = {
  setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms),
  // @ts-expect-error — timer ID is opaque; Node accepts any value at runtime
  clearTimeout: (id) => { globalThis.clearTimeout(id); },
};

// --- Utilities ---

/** Shared no-op function for catch handlers, callbacks, etc. */
// eslint-disable-next-line @typescript-eslint/no-empty-function -- intentional
export const noop = (): void => {};

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

export const LSP_MESSAGE_TYPE = {
  Error: 1,
  Warning: 2,
  Info: 3,
  Log: 4,
} as const;
