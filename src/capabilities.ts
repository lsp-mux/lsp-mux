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
