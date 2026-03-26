export type ServerCapabilities = Record<string, unknown>;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isArray = (v: unknown): v is unknown[] => Array.isArray(v);

const mergeValues = (a: unknown, b: unknown): unknown => {
  if (typeof a === 'boolean' && typeof b === 'boolean') return a || b;
  if (typeof a === 'number' && typeof b === 'number') return Math.max(a, b);
  if (isArray(a) && isArray(b)) return [...a, ...b];
  if (isPlainObject(a) && isPlainObject(b)) return { ...a, ...b };
  return b;
};

/** Merge capabilities from multiple servers into a single capabilities object.
 *
 *  Strategy (simple for M2, deep merge deferred to M4):
 *  - Boolean values: OR (true if any server provides it)
 *  - Objects: shallow merge (later servers override earlier for same keys)
 *  - Numbers: max (e.g., textDocumentSync — take the highest sync level)
 *  - Arrays: concatenate
 *  - First server is the "base" — subsequent servers augment
 *
 *  Returns empty object if input is empty.
 */
export const mergeCapabilities = (
  capabilities: readonly ServerCapabilities[],
): ServerCapabilities =>
  capabilities.reduce<ServerCapabilities>((merged, caps) => {
    for (const [key, value] of Object.entries(caps)) {
      merged[key] = key in merged ? mergeValues(merged[key], value) : value;
    }
    return merged;
  }, {});
