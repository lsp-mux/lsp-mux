// Type for a single LSP diagnostic (kept as unknown — we don't need to parse internals)
export type Diagnostic = unknown;

// Inner map: serverName → diagnostics array for that URI
export type PerUriStore = ReadonlyMap<string, readonly Diagnostic[]>;

// Outer map: uri → per-server diagnostics
export type DiagnosticsStore = ReadonlyMap<string, PerUriStore>;

/** Empty store. */
export const empty = (): DiagnosticsStore => new Map();

/** Update diagnostics for one server + URI. Returns new store.
 *  If diagnostics array is empty, removes the server's entry for that URI.
 *  If the URI has no more server entries, removes the URI entirely. */
export const update = (
  store: DiagnosticsStore,
  serverName: string,
  uri: string,
  diagnostics: readonly Diagnostic[],
): DiagnosticsStore => {
  const perUri = new Map(store.get(uri) ?? []);

  if (diagnostics.length === 0) {
    perUri.delete(serverName);
  } else {
    perUri.set(serverName, diagnostics);
  }

  const next = new Map(store);
  if (perUri.size === 0) {
    next.delete(uri);
  } else {
    next.set(uri, perUri);
  }
  return next;
};

/** Merge all servers' diagnostics for a URI into a single flat array (union). */
export const merge = (store: DiagnosticsStore, uri: string): readonly Diagnostic[] => {
  const perUri = store.get(uri);
  if (!perUri) return [];
  return [...perUri.values()].flat();
};

/** Remove all entries for a server (e.g., on crash).
 *  Returns the new store and the list of affected URIs (so caller can re-publish). */
export const clearServer = (
  store: DiagnosticsStore,
  serverName: string,
): { readonly store: DiagnosticsStore; readonly affectedUris: readonly string[] } => {
  const affectedUris: string[] = [];
  const next = new Map<string, PerUriStore>();

  for (const [uri, perUri] of store) {
    if (!perUri.has(serverName)) {
      next.set(uri, perUri);
      continue;
    }
    affectedUris.push(uri);
    const updated = new Map(perUri);
    updated.delete(serverName);
    if (updated.size > 0) {
      next.set(uri, updated);
    }
  }

  return { store: next, affectedUris };
};
