import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Normalize a file URI to the standard `file:///` format.
 *
 * Some LSP servers (e.g., vtsls on Windows) emit non-standard URIs with
 * backslashes and missing authority slashes (`file://C:\...` instead of
 * `file:///C:/...`). This causes issues when the URI is consumed by other
 * servers (e.g., ESLint's workingDirectory resolution).
 *
 * Normalizes by round-tripping through fileURLToPath → pathToFileURL.
 * Results are cached since the same URI always normalizes the same way
 * and the set of distinct URIs is bounded by tracked files.
 * Returns the original string unchanged for non-file URIs or on parse failure.
 */
const cache = new Map<string, string>();

export const normalizeFileUri = (uri: string): string => {
  if (!uri.startsWith('file:')) return uri;
  const cached = cache.get(uri);
  if (cached !== undefined) return cached;
  try {
    const fsPath = fileURLToPath(uri);
    // Canonicalize Windows drive letter to lowercase so C: and c: map
    // to the same URI — they're the same path on Windows.
    const canonical = /^[A-Z]:/.test(fsPath)
      ? fsPath.replace(/^[A-Z]/, c => c.toLowerCase())
      : fsPath;
    const normalized = pathToFileURL(canonical).href;
    cache.set(uri, normalized);
    return normalized;
  }
  catch {
    cache.set(uri, uri);
    return uri;
  }
};
