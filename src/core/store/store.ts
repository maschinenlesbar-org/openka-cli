// The corpus seam. Everything the line persists goes through this interface, so
// the pipeline, search and the CLI can be driven against an in-memory store in
// tests without touching a filesystem — the same trick `Transport` plays for HTTP.

import type { KaRecord } from "../models/schema.js";
import type { IndexShard } from "./fts.js";

/**
 * The denormalised row the search and list commands read, so neither has to load
 * every full record from disk to filter or display results.
 */
export interface CatalogEntry {
  id: string;
  parliament: string;
  reference: string;
  legislative_period: number;
  title: string;
  /** Distinct party labels of the askers, sorted, lowercased for matching. */
  parties: string[];
  submitted?: string;
  answered?: string;
  /** Calendar year used by `--year`: the year the Anfrage was asked. */
  year?: number;
  review_status: string;
  tier: string;
  abstained: number;
  /** Number of tokens indexed for this document — kept so removals stay exact. */
  terms: number;
}

/** Per-source bookkeeping: what was last seen, and the conditional-request state. */
export interface SourceState {
  source: string;
  last_sync?: string;
  last_success?: string;
  /** Per-URL ETag / Last-Modified, so unchanged documents are never re-fetched. */
  http_cache: Record<string, { etag?: string; last_modified?: string; sha256?: string }>;
  /** Last error message, kept so `ka sources list` can show a degraded source. */
  last_error?: string;
  documents_seen?: number;
}

export interface Store {
  /** Absolute path of the corpus root, for messages and `ka open`. */
  readonly root: string;

  hasBlob(sha256: string): boolean;
  /** Store bytes under their own digest; returns the digest. Idempotent. */
  putBlob(data: Buffer): string;
  getBlob(sha256: string): Buffer;
  /** Filesystem path of a stored blob — what `ka open` hands to the OS. */
  blobPath(sha256: string): string;

  hasRecord(id: string): boolean;
  getRecord(id: string): KaRecord | undefined;
  /** Canonical bytes of a stored record, exactly as they sit on disk. */
  getRecordBytes(id: string): Buffer | undefined;
  putRecord(record: KaRecord): void;
  deleteRecord(id: string): void;
  /** Every record id in the corpus, sorted. */
  recordIds(): string[];

  /** Every catalog row, ordered by id. */
  catalog(): CatalogEntry[];
  catalogEntry(id: string): CatalogEntry | undefined;
  putCatalogEntry(entry: CatalogEntry): void;
  removeCatalogEntry(id: string): void;

  loadShard(shard: string): IndexShard;
  saveShard(shard: string, data: IndexShard): void;
  /** Every index shard present, sorted. */
  shardNames(): string[];

  getSourceState(source: string): SourceState;
  putSourceState(state: SourceState): void;

  /** Frozen embeddings produced by the factory, if any were shipped. */
  loadEmbeddings(): EmbeddingSet | undefined;
  saveEmbeddings(set: EmbeddingSet): void;
}

/**
 * Semantic search vectors. They are *precomputed in the factory and frozen* — the
 * line never embeds anything at runtime, which is why the model that produced them
 * is recorded here by name and hash rather than being callable.
 */
export interface EmbeddingSet {
  model: string;
  model_sha256?: string;
  dimensions: number;
  /** Document id -> unit-length vector. */
  vectors: Record<string, number[]>;
}
