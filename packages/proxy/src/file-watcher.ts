import { realpath } from 'node:fs/promises';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import picomatch from 'picomatch';
import * as v from 'valibot';

// --- LSP file change types ---

export const FileChangeType = {
  Created: 1,
  Changed: 2,
  Deleted: 3,
} as const;

export const WatchKind = {
  Create: 1,
  Change: 2,
  Delete: 4,
  All: 7,
} as const;

// Map LSP FileChangeType to WatchKind bitmask
const changeTypeToKind: Record<number, number> = {
  [FileChangeType.Created]: WatchKind.Create,
  [FileChangeType.Changed]: WatchKind.Change,
  [FileChangeType.Deleted]: WatchKind.Delete,
};

// --- Schemas ---

const WorkspaceFolderSchema = v.object({ uri: v.string(), name: v.string() });

const GlobPatternSchema = v.union([
  v.string(),
  v.object({
    baseUri: v.union([v.string(), WorkspaceFolderSchema]),
    pattern: v.string(),
  }),
]);

const FileSystemWatcherSchema = v.object({
  globPattern: GlobPatternSchema,
  kind: v.optional(v.number()),
});

export const RegisterOptionsSchema = v.object({
  watchers: v.array(FileSystemWatcherSchema),
});

// --- Types ---

interface CompiledWatcher {
  readonly globPattern: string;
  readonly kind: number;
  readonly match: (path: string) => boolean;
}

interface Registration {
  readonly id: string;
  readonly serverName: string;
  readonly watchers: readonly CompiledWatcher[];
}

export type WatchRegistrations = ReadonlyMap<string, Registration>;

export interface FileChange {
  readonly uri: string;
  readonly type: number;
}

// --- Pure functions ---

export const empty = (): WatchRegistrations => new Map();

/**
 * Classify an fs.watch event into an LSP FileChangeType.
 *
 * `fs.watch` emits 'rename' for both genuine creates and atomic saves
 * (rename-to-target). These are indistinguishable at the watcher level,
 * so we always classify file-exists as Changed and file-missing as Deleted.
 * This is the safe default — WatchKind.Change-only watchers (e.g.,
 * tsconfig watchers) won't silently drop atomic-save events.
 */
export const classifyChange = (exists: boolean): number =>
  exists ? FileChangeType.Changed : FileChangeType.Deleted;

/**
 * Create an exclude matcher from glob patterns.
 * Returns a function that tests a workspace-relative path against the patterns.
 */
export const createExcludeMatcher = (
  patterns: readonly string[],
): (path: string) => boolean =>
  patterns.length > 0
    ? picomatch([...patterns])
    : () => false;

const resolveBaseUri = (baseUri: string | { uri: string; name: string }, workspaceRoot?: string): string => {
  const raw = typeof baseUri === 'string' ? baseUri : baseUri.uri;
  if (workspaceRoot && raw.startsWith('file://')) {
    try {
      const absPath = fileURLToPath(raw);
      return relative(workspaceRoot, absPath).replaceAll('\\', '/');
    } catch {
      // fileURLToPath failed (malformed URI) — fall through to trailing-slash strip
    }
  }
  return raw.replace(/\/$/, '');
};

const compileGlob = (
  pattern: v.InferOutput<typeof GlobPatternSchema>,
  workspaceRoot?: string,
): string => {
  if (typeof pattern === 'string') return pattern;
  const base = resolveBaseUri(pattern.baseUri, workspaceRoot);
  return `${base}/${pattern.pattern}`;
};

export const register = (
  state: WatchRegistrations,
  serverName: string,
  registrationId: string,
  options: v.InferOutput<typeof RegisterOptionsSchema>,
  workspaceRoot?: string,
): WatchRegistrations => {
  const watchers = options.watchers.map((w): CompiledWatcher => {
    const glob = compileGlob(w.globPattern, workspaceRoot);
    return {
      globPattern: glob,
      kind: w.kind ?? WatchKind.All,
      match: picomatch(glob, { dot: true }),
    };
  });

  const next = new Map(state);
  next.set(registrationId, { id: registrationId, serverName, watchers });
  return next;
};

export const unregister = (
  state: WatchRegistrations,
  registrationId: string,
): WatchRegistrations => {
  if (!state.has(registrationId)) return state;
  const next = new Map(state);
  next.delete(registrationId);
  return next;
};

export const unregisterServer = (
  state: WatchRegistrations,
  serverName: string,
): WatchRegistrations => {
  let isChanged = false;
  const next = new Map(state);
  for (const [id, reg] of next) {
    if (reg.serverName !== serverName) {
    	continue;
    }

    next.delete(id);
    isChanged = true;
  }
  return isChanged ? next : state;
};

/**
 * Match a file event against all registrations.
 * Returns a map of serverName → FileChange[] for dispatch.
 * @param relativePath Forward-slash-separated path relative to workspace root
 * @param changeType LSP FileChangeType (1=Created, 2=Changed, 3=Deleted)
 * @param fileUri Full file:// URI for the changed file
 */
export const matchEvent = (
  state: WatchRegistrations,
  relativePath: string,
  changeType: number,
  fileUri: string,
): ReadonlyMap<string, FileChange[]> => {
  const kindBit = changeTypeToKind[changeType] ?? 0;
  const result = new Map<string, FileChange[]>();

  const matched = new Set<string>();
  for (const reg of state.values()) {
    // Skip if this server already matched (dedup across registrations)
    if (matched.has(reg.serverName)) continue;

    for (const watcher of reg.watchers) {
      if ((watcher.kind & kindBit) === 0) continue;
      if (!watcher.match(relativePath)) continue;

      result.set(reg.serverName, [{ uri: fileUri, type: changeType }]);
      matched.add(reg.serverName);
      break; // One match per registration is sufficient
    }
  }

  return result;
};

/**
 * Resolve the workspace root once via `realpath` (follows symlinks).
 * The result is passed to `isWithinRoot` to avoid re-resolving on every event.
 */
export const resolveRoot = async (root: string): Promise<string> => {
  try {
    return await realpath(root);
  } catch {
    return resolve(root);
  }
};

/**
 * Check whether a path is within a pre-resolved workspace root.
 * Guards against path traversal via `..` segments and symlinks.
 *
 * When the file exists, both paths are compared via `realpath` (symlink-safe).
 * When the file doesn't exist (delete events), both paths are compared via
 * lexical `resolve()` so they stay in the same namespace — otherwise a
 * symlinked workspace root (realpath) would never match a deleted file path
 * (resolve fallback in the symlink namespace).
 * @param resolvedRoot — result of `resolveRoot()`, cached by the caller
 */
export const isWithinRoot = async (fullPath: string, resolvedRoot: string): Promise<boolean> => {
  const isContainedIn = (child: string, root: string): boolean =>
    child === root || child.startsWith(root + sep);

  try {
    return isContainedIn(await realpath(fullPath), resolvedRoot);
  } catch {
    // File doesn't exist (e.g., delete event). Resolve the parent directory
    // via realpath (it likely still exists) and append the filename, so we
    // stay in the same namespace as the realpath-resolved root. This handles
    // symlinked workspace roots where resolve(fullPath) would produce a path
    // in the symlink namespace that never matches the real-path root.
    try {
      const resolvedParent = await realpath(dirname(fullPath));
      return isContainedIn(resolve(resolvedParent, basename(fullPath)), resolvedRoot);
    } catch {
      // Parent also doesn't exist — fall back to lexical normalization
      return isContainedIn(resolve(fullPath), resolve(resolvedRoot));
    }
  }
};
