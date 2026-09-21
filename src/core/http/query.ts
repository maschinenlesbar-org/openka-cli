// A dependency-free query-string builder. Kept separate from the engine so the
// encoding rules are unit-testable on their own.

export type QueryValue = string | number | boolean | undefined | null | readonly (string | number)[];
export type QueryParams = Record<string, QueryValue>;

/**
 * Build a query string from params. Keys are emitted in sorted order so the same
 * params always yield the same URL — which is what makes the HTTP cache keys, and
 * therefore a sync run, reproducible. Array values repeat the key.
 */
export function buildQuery(params: QueryParams): string {
  const parts: string[] = [];
  for (const key of Object.keys(params).sort()) {
    const value = params[key];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(item))}`);
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
  }
  return parts.join("&");
}
