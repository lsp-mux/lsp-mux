export type ServerCapabilities = Record<string, unknown>;

export const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isArray = (v: unknown): v is unknown[] => Array.isArray(v);

const mergeValues = (a: unknown, b: unknown): unknown => {
  if (typeof a === 'boolean' && typeof b === 'boolean') return a || b;
  if (typeof a === 'number' && typeof b === 'number') return Math.max(a, b);
  if (isArray(a) && isArray(b)) return [...a, ...b];
  if (isPlainObject(a) && isPlainObject(b)) return deepMerge(a, b);
  return b;
};

const deepMerge = (
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): Record<string, unknown> => {
  const result: Record<string, unknown> = { ...a };
  for (const [key, value] of Object.entries(b)) {
    result[key] = key in result ? mergeValues(result[key], value) : value;
  }
  return result;
};

/** Merge capabilities from multiple servers into a single capabilities object.
 *
 *  Strategy (recursive deep merge):
 *  - Boolean values: OR (true if any server provides it)
 *  - Objects: recursive deep merge (all keys from all servers are preserved)
 *  - Numbers: max (e.g., textDocumentSync — take the highest sync level)
 *  - Arrays: concatenate
 *  - First server is the "base" — subsequent servers augment
 *
 *  Returns empty object if input is empty.
 */
export const mergeCapabilities = (
  capabilities: readonly ServerCapabilities[],
): ServerCapabilities =>
  capabilities.reduce<ServerCapabilities>(deepMerge, {});

/** Static capabilities the proxy advertises during initialize.
 *
 *  Child servers are started lazily (on first matching file open), so
 *  their actual capabilities aren't known at init time. The proxy declares
 *  a permissive superset. Unsupported methods get natural null/error
 *  responses from servers.
 */
export const STATIC_CAPABILITIES: ServerCapabilities = {
  textDocumentSync: 1,
  hoverProvider: true,
  completionProvider: {
    triggerCharacters: ['.', ':', '<', '"', '\'', '/', '@', '#'],
    resolveProvider: true,
  },
  signatureHelpProvider: { triggerCharacters: ['(', ','] },
  definitionProvider: true,
  typeDefinitionProvider: true,
  implementationProvider: true,
  declarationProvider: true,
  referencesProvider: true,
  documentHighlightProvider: true,
  documentSymbolProvider: true,
  workspaceSymbolProvider: true,
  codeActionProvider: true,
  codeLensProvider: { resolveProvider: true },
  documentLinkProvider: { resolveProvider: true },
  colorProvider: true,
  documentFormattingProvider: true,
  documentRangeFormattingProvider: true,
  renameProvider: { prepareProvider: true },
  foldingRangeProvider: true,
  selectionRangeProvider: true,
  linkedEditingRangeProvider: true,
  callHierarchyProvider: true,
  typeHierarchyProvider: true,
  inlayHintProvider: true,
  diagnosticProvider: { interFileDependencies: true, workspaceDiagnostics: false },
};
