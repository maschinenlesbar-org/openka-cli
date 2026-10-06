// The corpus seam. Everything the line persists goes through this interface, so
// the pipeline, search and the CLI can be driven against an in-memory store in
// tests without touching a filesystem — the same trick `Transport` plays for HTTP.

import { CorpusLockedError } from "@maschinenlesbar.org/openka-lib-errors";
import type { KaRecord } from "@maschinenlesbar.org/openka-lib-models";
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
  /** Calendar year used by `--year`: the year the Anfrage was asked; absent when that is unknown. */
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

/**
 * The corpus, as the roles that make it up.
 *
 * `Store` is their intersection and nothing in the codebase has to change because
 * of the split — but a consumer that only reads the catalog can now say so, and a
 * test double for it does not have to implement blob addressing, index sharding
 * and artifact storage to compile. `DiscoverOptions` already took this shape by
 * hand (`Pick<Store, "loadArtifact">`); these are the seams it was reaching for.
 *
 * The file store draws exactly these lines with section separators, which is the
 * class saying out loud that it is nine concerns wearing one name.
 */
export interface BlobStore {
  hasBlob(sha256: string): boolean;
  /** Store bytes under their own digest; returns the digest. Idempotent. */
  putBlob(data: Buffer): string;
  getBlob(sha256: string): Buffer;
  /** Filesystem path of a stored blob — what `ka open` hands to the OS. */
  blobPath(sha256: string): string;
  /**
   * Throw `StoreError` when the blobs cannot be reached at all — a blob directory
   * on a drive that is not mounted. Optional: a store whose blobs are always there
   * (the in-memory double) has nothing to check.
   */
  assertBlobStore?(): void;
}

export interface RecordStore {
  hasRecord(id: string): boolean;
  getRecord(id: string): KaRecord | undefined;
  /** Canonical bytes of a stored record, exactly as they sit on disk. */
  getRecordBytes(id: string): Buffer | undefined;
  putRecord(record: KaRecord): void;
  deleteRecord(id: string): void;
  /** Every record id in the corpus, sorted. */
  recordIds(): string[];
}

export interface CatalogStore {
  /** Every catalog row, ordered by id. */
  catalog(): CatalogEntry[];
  catalogEntry(id: string): CatalogEntry | undefined;
  putCatalogEntry(entry: CatalogEntry): void;
  /**
   * Insert or replace many rows and persist once.
   *
   * `putCatalogEntry` rewrites the whole catalog on every call, so building an
   * index a record at a time wrote it N times — 5.6 MiB to land a 153 KiB file
   * for 200 records, quadratic in the corpus.
   */
  putCatalogEntries(entries: readonly CatalogEntry[]): void;
  removeCatalogEntry(id: string): void;
  /**
   * Replace every catalog row with `entries` and persist, without reading what is
   * there. That is what a rebuild needs: `ka reindex` read the old catalog in order
   * to clear it, so a corrupt catalog was the one thing it could not repair.
   */
  replaceCatalog(entries: readonly CatalogEntry[]): void;
  /**
   * Run `work` with catalog writes deferred, and persist the catalog once when it
   * returns — also when it throws, so an interrupted run keeps what it indexed.
   *
   * `putCatalogEntry` persists on every call, which is the right default for a
   * one-off caller and the wrong shape for a sync: indexing a record at a time
   * re-read and rewrote the whole catalog per record, quadratic in the corpus.
   * The pipeline wraps its record loop in this; nested batches flush once, at the
   * outermost, and concurrent ones each at their own end.
   */
  batchCatalog<T>(work: () => Promise<T>): Promise<T>;
}

export interface IndexStore {
  loadShard(shard: string): IndexShard;
  saveShard(shard: string, data: IndexShard): void;
  /** Every index shard present, sorted. */
  shardNames(): string[];
}

export interface SourceStateStore {
  getSourceState(source: string): SourceState;
  putSourceState(state: SourceState): void;
  /**
   * Every source that has state in this corpus, sorted — including one that
   * synced and stored nothing. The health report needs it: a source is otherwise
   * only visible through the records it produced, so the very case worth flagging
   * (discovery returned nothing) is the case that leaves no trace.
   */
  sourceStateKeys(): string[];
}

export interface ArtifactStore {
  /**
   * A frozen artifact the factory built and the line consumes — see CONCEPT.md §0.
   * Named, JSON, and written once by a build-time job rather than by a sync.
   */
  loadArtifact<T>(name: string): T | undefined;
  saveArtifact(name: string, value: unknown): void;
}

export interface EmbeddingStore {
  /** Frozen embeddings produced by the factory, if any were shipped. */
  loadEmbeddings(): EmbeddingSet | undefined;
  saveEmbeddings(set: EmbeddingSet): void;
}

/**
 * Exclusive write access to a corpus. Optional: a store that cannot be shared
 * (the in-memory test double) has nothing to lock.
 */
export interface LockableStore {
  /**
   * Take the corpus for writing, or throw `CorpusLockedError` when another run
   * holds it. Returns the release. Re-entrant within one store object, so a
   * writer may call another writer; `withCorpusLock` is the usual way in.
   */
  lock?(purpose: string): () => void;
}

export interface Store
  extends BlobStore,
    RecordStore,
    CatalogStore,
    IndexStore,
    SourceStateStore,
    ArtifactStore,
    EmbeddingStore,
    LockableStore {
  /** Absolute path of the corpus root, for messages and `ka open`. */
  readonly root: string;
}

export interface LockCorpusOptions {
  /**
   * While another run holds the lock, wait for it instead of throwing
   * `CorpusLockedError` — what a queue of syncs wants. Checked every `pollMs`.
   */
  wait?: boolean;
  /** How often a waiting caller tries again (default `LOCK_POLL_MS`). */
  pollMs?: number;
  /** Stop waiting: the `CorpusLockedError` is thrown then. */
  signal?: AbortSignal;
  /** Called once, when the first attempt finds the lock held and waiting begins. */
  onWaiting?: (held: CorpusLockedError) => void;
  /** Injectable for tests; the default sleeps with a timer that `signal` cuts short. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** How often `lockCorpus({ wait: true })` tries the lock again. */
export const LOCK_POLL_MS = 2000;

/**
 * Take the store's write lock and return its release, waiting while another run
 * holds it when `wait` is set. Without `wait` it is `store.lock`: a held lock
 * throws `CorpusLockedError`. A store without a lock returns a release that does
 * nothing. Two syncs against one corpus used to need a shell loop polling `pgrep`
 * to queue the second one behind the first.
 */
export async function lockCorpus(store: LockableStore, purpose: string, options: LockCorpusOptions = {}): Promise<() => void> {
  const noop = (): void => undefined;
  if (store.lock === undefined) return noop;
  const sleep = options.sleep ?? abortableSleep;
  const aborted = (): boolean => options.signal?.aborted === true;
  for (let attempt = 0; ; attempt++) {
    try {
      return store.lock(purpose);
    } catch (err) {
      if (!(err instanceof CorpusLockedError) || options.wait !== true || aborted()) throw err;
      if (attempt === 0) options.onWaiting?.(err);
      await sleep(options.pollMs ?? LOCK_POLL_MS, options.signal);
      if (aborted()) throw err;
    }
  }
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
  });
}

/** Run `work` holding the store's write lock, when it has one, and release it after. */
export function withCorpusLock<T>(store: LockableStore, purpose: string, work: () => T): T {
  const release = store.lock?.(purpose);
  let result: T;
  try {
    result = work();
  } catch (err) {
    release?.();
    throw err;
  }
  if (result instanceof Promise) {
    return result.finally(() => release?.()) as T;
  }
  release?.();
  return result;
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
