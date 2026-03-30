import { isPlainObject } from './utils.js';

/**
 * Deep-merge two plain objects. Objects merge recursively (keys from
 * override win per-key). Arrays, scalars, and null replace outright.
 * Undefined values in the override are skipped.
 */
export const deepMerge = (
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> => {
  const result: Record<string, unknown> = { ...base };
  for (const key of Object.keys(override)) {
    const overrideVal = override[key];
    if (overrideVal === undefined) continue;
    const baseVal = result[key];
    result[key] = isPlainObject(baseVal) && isPlainObject(overrideVal)
      ? deepMerge(baseVal, overrideVal)
      : overrideVal;
  }
  return result;
};
