import * as v from 'valibot';
import type { ServerConfig, Message } from './types.js';

// --- Types ---

export interface ServerEntry {
  readonly name: string;
  readonly config: ServerConfig;
}

export interface Router {
  /** All server names that handle a URI's file type (for fanout).
   *  Returns allServers if URI is undefined or extension is unknown. */
  serversForUri(uri: string | undefined): readonly string[];
  /** First server that handles a URI's file type (for single-response routing).
   *  Returns first of allServers if URI is undefined or extension is unknown. */
  primaryForUri(uri: string | undefined): string | undefined;
  /** All configured server names, in config order. */
  readonly allServers: readonly string[];
}

// --- Internal helpers (pure) ---

/** Build extension → languageId map from all servers' languages config. First server wins on conflicts. */
const buildExtToLang = (servers: readonly ServerEntry[]): ReadonlyMap<string, string> => {
  const map = new Map<string, string>();
  for (const { config } of servers) {
    for (const [langId, exts] of Object.entries(config.languages)) {
      for (const ext of exts) {
        if (!map.has(ext)) map.set(ext, langId);
      }
    }
  }
  return map;
};

/** Build languageId → server names (in config order). */
const buildLangToServers = (servers: readonly ServerEntry[]): ReadonlyMap<string, readonly string[]> => {
  const map = new Map<string, string[]>();
  for (const { name, config } of servers) {
    for (const langId of Object.keys(config.languages)) {
      const list = map.get(langId);
      if (list) list.push(name);
      else map.set(langId, [name]);
    }
  }
  return map;
};

/** Extract the file extension (e.g. `.ts`) from a URI string, or undefined if none. */
const extractExtension = (uri: string): string | undefined => {
  try {
    const pathname = new URL(uri).pathname;
    const filename = pathname.slice(pathname.lastIndexOf('/') + 1);
    const dotIdx = filename.lastIndexOf('.');
    return dotIdx >= 0 ? filename.slice(dotIdx) : undefined;
  } catch {
    return undefined;
  }
};

/** Resolve server names for a URI via extension → languageId → servers lookup. */
const resolveServers = (
  uri: string | undefined,
  extToLang: ReadonlyMap<string, string>,
  langToServers: ReadonlyMap<string, readonly string[]>,
  allServers: readonly string[],
): readonly string[] => {
  if (uri === undefined) return allServers;
  const ext = extractExtension(uri);
  if (ext === undefined) return allServers;
  const langId = extToLang.get(ext);
  if (langId === undefined) return allServers;
  return langToServers.get(langId) ?? allServers;
};

// --- Public API ---

/** Create a router from server entries (in config order). */
export const createRouter = (servers: readonly ServerEntry[]): Router => {
  const allServers = servers.map((s) => s.name);
  const extToLang = buildExtToLang(servers);
  const langToServers = buildLangToServers(servers);

  return {
    allServers,
    serversForUri: (uri) => resolveServers(uri, extToLang, langToServers, allServers),
    primaryForUri: (uri) => resolveServers(uri, extToLang, langToServers, allServers)[0],
  };
};

const ParamsUriSchema = v.union([
  v.pipe(
    v.object({ textDocument: v.object({ uri: v.string() }) }),
    v.transform(({ textDocument }) => textDocument.uri),
  ),
  v.pipe(
    v.object({ uri: v.string() }),
    v.transform(({ uri }) => uri),
  ),
]);

/** Extract textDocument.uri from LSP message params (if present).
 *  Handles both `params.textDocument.uri` and `params.uri` shapes. */
export const extractUri = (msg: Message): string | undefined => {
  const params = 'params' in msg ? msg.params : undefined;
  const result = v.safeParse(ParamsUriSchema, params);
  return result.success ? result.output : undefined;
};
