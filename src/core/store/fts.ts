// The full-text index: tokenizer, scoring and sharding — all pure functions, so
// the ranking of a search result is reproducible and unit-testable without touching
// a filesystem.
//
// This replaces SQLite FTS5 from the concept: the line has no runtime dependencies
// and Node's built-in SQLite is not available on Node 20, so the index is a set of
// JSON shards written by `FileStore`.

import { createHash } from "node:crypto";

/** How much more a token in the title counts than one in the body. */
export const TITLE_BOOST = 3;

const UMLAUTS: Record<string, string> = { ä: "ae", ö: "oe", ü: "ue", ß: "ss" };

/**
 * Normalise a single term: lowercase, expand German umlauts the way German search
 * users expect (`Brücken` and `Bruecken` must match), then strip any remaining
 * combining marks. Deterministic and independent of the host locale — `toLowerCase`
 * is called without a locale argument on purpose, since a Turkish locale would
 * otherwise map `I` differently and change the index on a different machine.
 */
export function normalizeTerm(term: string): string {
  let out = "";
  for (const ch of term.normalize("NFC").toLowerCase()) {
    out += UMLAUTS[ch] ?? ch;
  }
  return out
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .normalize("NFC");
}

/**
 * Split text into index terms. Tokens are runs of letters and digits; single
 * characters are dropped (they carry no selectivity and bloat the index).
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const raw of normalizeTerm(text).split(/[^0-9a-z]+/)) {
    if (raw.length >= 2) tokens.push(raw);
  }
  return tokens;
}

/** The shard a token's postings live in: the first byte of its sha256, as hex. */
export function shardOf(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex").slice(0, 2);
}

/** `[documentId, termFrequency]`, sorted by document id inside a shard. */
export type Posting = [string, number];

/** One index shard: token -> postings. */
export type IndexShard = Record<string, Posting[]>;

/**
 * Count term frequencies for one document, with the title weighted by
 * `TITLE_BOOST`. Returns a map in insertion order; callers sort where order matters.
 */
export function termFrequencies(fields: { title?: string; body?: string; extra?: string[] }): Map<string, number> {
  const counts = new Map<string, number>();
  const add = (text: string, weight: number): void => {
    for (const token of tokenize(text)) {
      counts.set(token, (counts.get(token) ?? 0) + weight);
    }
  };
  if (fields.title) add(fields.title, TITLE_BOOST);
  if (fields.body) add(fields.body, 1);
  for (const extra of fields.extra ?? []) add(extra, 1);
  return counts;
}

/**
 * BM25-flavoured but deliberately simpler: a saturating term weight times an IDF.
 * No document-length normalisation, because answer PDFs vary in length by two
 * orders of magnitude for reasons that say nothing about relevance, and because a
 * simpler formula is one fewer thing whose behaviour can drift between versions.
 */
export function scoreTerm(tf: number, documentFrequency: number, totalDocuments: number): number {
  if (tf <= 0 || documentFrequency <= 0) return 0;
  const idf = Math.log(1 + totalDocuments / documentFrequency);
  return (1 + Math.log(tf)) * idf;
}

/** A parsed query: required terms, optional terms and exact phrases. */
export interface ParsedQuery {
  /** Terms that must be present (`+term`, or every term in AND mode). */
  required: string[];
  /** Terms that contribute to the score but need not all match. */
  optional: string[];
  /** Quoted phrases, normalised to their token sequence. */
  phrases: string[][];
  /** Terms that must be absent (`-term`). */
  excluded: string[];
}

/**
 * Parse a query string. The syntax is intentionally tiny and documented in full:
 *
 *   brücken zustand      both terms must match (AND is the default)
 *   "marode brücke"      an exact phrase, checked against the stored text
 *   -sanierung           a term that must not appear
 *   +brücken zustand     explicit requirement (same as the default)
 *
 * There is no OR operator and no wildcard: every construct a user can type has a
 * single, obvious meaning, which matters more here than expressiveness.
 */
export function parseQuery(query: string): ParsedQuery {
  const parsed: ParsedQuery = { required: [], optional: [], phrases: [], excluded: [] };
  const pattern = /"([^"]*)"|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(query)) !== null) {
    const phrase = match[1];
    if (phrase !== undefined) {
      const tokens = tokenize(phrase);
      if (tokens.length > 0) {
        parsed.phrases.push(tokens);
        for (const token of tokens) if (!parsed.required.includes(token)) parsed.required.push(token);
      }
      continue;
    }
    const word = match[2] as string;
    const negated = word.startsWith("-");
    const body = word.replace(/^[+-]/, "");
    const tokens = tokenize(body);
    for (const token of tokens) {
      const bucket = negated ? parsed.excluded : parsed.required;
      if (!bucket.includes(token)) bucket.push(token);
    }
  }
  return parsed;
}

/**
 * Normalise `text` the way index terms are normalised, keeping a map back to the
 * original.
 *
 * Needed because normalisation is not length-preserving — `ü` becomes `ue`, a
 * combining mark disappears, and `İ` lowercases to two code units — so an offset
 * found in the normalised string does not point at the same character in the
 * original. `offsets[i]` is the index in `text` of the character that produced
 * `normalized[i]`, which is what lets a caller search normalised and then slice
 * the text the reader actually sees.
 */
export function normalizeWithOffsets(text: string): { normalized: string; offsets: number[] } {
  let normalized = "";
  const offsets: number[] = [];
  let at = 0;
  for (const character of text) {
    const mapped = normalizeTerm(character);
    for (let i = 0; i < mapped.length; i++) offsets.push(at);
    normalized += mapped;
    at += character.length;
  }
  return { normalized, offsets };
}

/** True when `tokens` occurs as a contiguous run in `haystack`'s token stream. */
export function containsPhrase(haystack: string, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const stream = tokenize(haystack);
  const first = tokens[0] as string;
  outer: for (let i = 0; i + tokens.length <= stream.length; i++) {
    if (stream[i] !== first) continue;
    for (let j = 1; j < tokens.length; j++) {
      if (stream[i + j] !== tokens[j]) continue outer;
    }
    return true;
  }
  return false;
}
