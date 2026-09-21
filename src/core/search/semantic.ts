// Semantic search over embeddings that were computed in the factory and frozen
// into the corpus. The line never embeds anything: there is no model to call here,
// only vectors to compare. A query therefore has to be a document that already has
// a vector (`--like <id>`), or a term whose vector the factory shipped.
//
// This is the honest shape of "semantic search without an LLM on the line". The
// alternative — embedding the user's query at runtime — would put a model back in
// the execution path, which §0 of the concept rules out.

import { OpenKaError } from "../errors.js";
import type { Store } from "../store/store.js";
import { matchesFilters, type SearchFilters, type SearchHit } from "./search.js";

/** Cosine similarity of two equal-length vectors. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) throw new OpenKaError(`Vector length mismatch: ${a.length} vs ${b.length}`);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface SemanticOptions extends SearchFilters {
  limit?: number;
  /** Discard hits below this cosine similarity. */
  minScore?: number;
}

/**
 * Rank records by similarity to the record `id`. Throws when the corpus carries no
 * frozen embeddings, rather than silently degrading to keyword search — a caller
 * asking for semantic results should learn that it did not get them.
 */
export function searchLike(store: Store, id: string, options: SemanticOptions = {}): SearchHit[] {
  const set = store.loadEmbeddings();
  if (set === undefined) {
    throw new OpenKaError(
      "This corpus has no frozen embeddings. Semantic search needs an embeddings file " +
        "built in the factory (ka-factory embed) — the line never embeds at runtime.",
    );
  }
  const query = set.vectors[id];
  if (query === undefined) {
    throw new OpenKaError(`No frozen embedding for record ${id}.`);
  }
  const limit = options.limit ?? 20;
  const minScore = options.minScore ?? 0;
  const hits: SearchHit[] = [];
  for (const [candidate, vector] of Object.entries(set.vectors)) {
    if (candidate === id) continue;
    const entry = store.catalogEntry(candidate);
    if (entry === undefined || !matchesFilters(entry, options)) continue;
    const score = cosine(query, vector);
    if (score < minScore) continue;
    hits.push({ entry, score });
  }
  hits.sort((a, b) => b.score - a.score || (a.entry.id < b.entry.id ? -1 : 1));
  return hits.slice(0, limit);
}
