// Frozen embeddings, built in the factory, consumed by the line.
//
// `ka search --like` needs vectors, and the concept is explicit that the line never
// embeds anything at runtime. That leaves two honest options: import vectors
// produced elsewhere, or compute them with something that is not a model. This
// module does the second.
//
// The embedder is a hashed TF-IDF random projection — classic, pre-neural, and
// fully deterministic: term frequencies weighted by inverse document frequency,
// projected onto a fixed number of dimensions through a seeded hash. It finds
// documents that share distinctive vocabulary. It does *not* understand language,
// and the name it records says so, so nobody reads more into a similarity score
// than it can carry.
//
// Importing real sentence-embedding vectors stays available through `--from`, and
// those record their own model name and hash.

import { createHash } from "node:crypto";
import { OpenKaError } from "../../core/errors.js";
import { readFileSync } from "node:fs";
import { tokenize } from "../../core/store/fts.js";
import { indexableFields } from "../../core/store/indexer.js";
import type { EmbeddingSet, Store } from "../../core/store/store.js";

/** The built-in embedder's name, recorded in the embedding set. */
export const HASHED_TFIDF = "hashed-tfidf-v1";

export const DEFAULT_DIMENSIONS = 256;

/** A term's fixed slot and sign, from its hash — the "random" projection. */
function projection(term: string, dimensions: number): { slot: number; sign: number } {
  const digest = createHash("sha256").update(term, "utf8").digest();
  const slot = digest.readUInt32BE(0) % dimensions;
  const sign = (digest[4] as number) % 2 === 0 ? 1 : -1;
  return { slot, sign };
}

/** Build frozen vectors for every record in the corpus. */
export function buildEmbeddings(store: Store, dimensions = DEFAULT_DIMENSIONS): EmbeddingSet {
  const ids = store.recordIds();
  const documents: { id: string; counts: Map<string, number> }[] = [];
  const documentFrequency = new Map<string, number>();

  for (const id of ids) {
    const record = store.getRecord(id);
    if (record === undefined) continue;
    const fields = indexableFields(record);
    const counts = new Map<string, number>();
    for (const token of tokenize([fields.title, fields.title, fields.body, ...fields.extra].join(" "))) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
    for (const term of counts.keys()) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    documents.push({ id, counts });
  }

  const total = documents.length || 1;
  const vectors: Record<string, number[]> = {};
  for (const { id, counts } of documents) {
    const vector = new Array<number>(dimensions).fill(0);
    for (const [term, tf] of counts) {
      const df = documentFrequency.get(term) ?? 1;
      const weight = (1 + Math.log(tf)) * Math.log(1 + total / df);
      const { slot, sign } = projection(term, dimensions);
      vector[slot] = (vector[slot] as number) + sign * weight;
    }
    // Unit length, so cosine similarity is a plain dot product and the scores of
    // a long document and a short one are comparable.
    const norm = Math.hypot(...vector);
    vectors[id] = norm === 0 ? vector : vector.map((value) => round(value / norm));
  }

  return { model: HASHED_TFIDF, dimensions, vectors };
}

/** Round to a fixed precision so the stored file is byte-stable across platforms. */
function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * Import vectors produced outside this project, as JSON Lines of
 * `{"id": "...", "vector": [...]}`. The model name and hash are recorded verbatim:
 * whatever produced them, the line still only ever compares numbers.
 */
export function importEmbeddings(
  path: string,
  options: { model: string; modelSha256?: string },
): EmbeddingSet {
  const vectors: Record<string, number[]> = {};
  let dimensions = 0;
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (err) {
    // Otherwise a missing --from path reached the CLI's "Unexpected error" branch,
    // which exists for genuine surprises, not for a path that is not there.
    const reason = err instanceof Error ? err.message : String(err);
    throw new OpenKaError(`could not read ${path}: ${reason}`, { cause: err });
  }
  const lines = source.split("\n");
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === "") return;
    let parsed: { id?: unknown; vector?: unknown };
    try {
      parsed = JSON.parse(trimmed) as { id?: unknown; vector?: unknown };
    } catch {
      throw new Error(`${path}:${index + 1}: not valid JSON`);
    }
    if (typeof parsed.id !== "string" || !Array.isArray(parsed.vector)) {
      throw new Error(`${path}:${index + 1}: expected {"id": string, "vector": number[]}`);
    }
    const vector = parsed.vector.map((value) => {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`${path}:${index + 1}: vector contains a non-finite value`);
      }
      return value;
    });
    // An empty vector left `dimensions` at 0, so the *next* line silently defined
    // the set's dimensionality and this one was kept at length 0 — a set that
    // imports cleanly and then throws "vector length mismatch" during a search.
    if (vector.length === 0) throw new Error(`${path}:${index + 1}: vector is empty`);
    if (dimensions === 0) dimensions = vector.length;
    else if (vector.length !== dimensions) {
      throw new Error(`${path}:${index + 1}: vector has ${vector.length} dimensions, expected ${dimensions}`);
    }
    // Overwriting silently would keep whichever line happened to come last.
    if (parsed.id in vectors) throw new Error(`${path}:${index + 1}: duplicate id "${parsed.id}"`);
    vectors[parsed.id] = vector;
  });

  const set: EmbeddingSet = { model: options.model, dimensions, vectors };
  if (options.modelSha256 !== undefined) set.model_sha256 = options.modelSha256;
  return set;
}
