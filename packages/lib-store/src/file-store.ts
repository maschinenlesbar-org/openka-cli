// The corpus on disk:
//
//   <root>/
//     blobs/<sha[0:2]>/<sha>.bin        content-addressed source documents
//     records/<id>.json                 canonical records, one file each
//     index/catalog.json                denormalised rows for filtering + listing
//     index/tokens/<shard>.json         inverted index shards (256 of them)
//     index/embeddings.json             frozen vectors, only if the factory shipped some
//     state/<source>.json               per-source sync + conditional-request state
//
// Everything is plain JSON in canonical form, so a corpus diffs cleanly in git, can
// be inspected with `cat`, and — crucially for the reproducibility claim — is
// byte-identical for the same inputs regardless of the machine that wrote it.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { StoreError } from "@maschinenlesbar.org/openka-lib-errors";
import { canonicalJsonLine } from "@maschinenlesbar.org/openka-lib-repro";
import { isSha256, sha256 } from "@maschinenlesbar.org/openka-lib-repro";
import { assertValidRecord } from "@maschinenlesbar.org/openka-lib-models";
import type { KaRecord } from "@maschinenlesbar.org/openka-lib-models";
import type { IndexShard } from "./fts.js";
import type { CatalogEntry, EmbeddingSet, SourceState, Store } from "./store.js";

/** Record ids and source keys reach the filesystem, so they are strictly checked. */
const SAFE_KEY = /^[a-z0-9][a-z0-9._-]*$/;

function assertSafeKey(value: string, what: string): void {
  if (!SAFE_KEY.test(value) || value.includes("..")) {
    throw new StoreError(`Unsafe ${what} "${value}": expected [a-z0-9][a-z0-9._-]*`);
  }
}

export class FileStore implements Store {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  // ---------------------------------------------------------------- paths

  private path(...parts: string[]): string {
    return join(this.root, ...parts);
  }

  blobPath(digest: string): string {
    if (!isSha256(digest)) throw new StoreError(`Not a sha256 digest: ${digest}`);
    return this.path("blobs", digest.slice(0, 2), `${digest}.bin`);
  }

  private recordPath(id: string): string {
    assertSafeKey(id, "record id");
    return this.path("records", `${id}.json`);
  }

  // ------------------------------------------------------------- file I/O

  /**
   * Write atomically: a crash or a full disk must never leave a half-written
   * record or index shard behind, because a truncated JSON file would look like
   * corpus corruption rather than an interrupted run.
   */
  private writeAtomic(path: string, data: Buffer | string): void {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp-${process.pid}`;
    try {
      writeFileSync(temporary, data);
      renameSync(temporary, path);
    } catch (err) {
      rmSync(temporary, { force: true });
      const reason = err instanceof Error ? err.message : String(err);
      throw new StoreError(`Could not write ${path}: ${reason}`, { cause: err });
    }
  }

  private readJson<T>(path: string, fallback: T): T {
    if (!existsSync(path)) return fallback;
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new StoreError(`Could not read ${path}: ${reason}`, { cause: err });
    }
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      throw new StoreError(`Corrupt JSON in ${path}`, { cause: err });
    }
  }

  private writeJson(path: string, value: unknown): void {
    this.writeAtomic(path, canonicalJsonLine(value));
  }

  // --------------------------------------------------------------- blobs

  hasBlob(digest: string): boolean {
    return existsSync(this.blobPath(digest));
  }

  putBlob(data: Buffer): string {
    const digest = sha256(data);
    const path = this.blobPath(digest);
    // Content-addressed: identical bytes are already the same file. Re-writing
    // would only risk replacing a good blob with a truncated one.
    if (!existsSync(path)) this.writeAtomic(path, data);
    return digest;
  }

  getBlob(digest: string): Buffer {
    const path = this.blobPath(digest);
    if (!existsSync(path)) throw new StoreError(`No blob ${digest} in ${this.root}`);
    return readFileSync(path);
  }

  // -------------------------------------------------------------- records

  hasRecord(id: string): boolean {
    return existsSync(this.recordPath(id));
  }

  getRecordBytes(id: string): Buffer | undefined {
    const path = this.recordPath(id);
    return existsSync(path) ? readFileSync(path) : undefined;
  }

  getRecord(id: string): KaRecord | undefined {
    const bytes = this.getRecordBytes(id);
    if (bytes === undefined) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch (err) {
      throw new StoreError(`Corrupt record ${id}`, { cause: err });
    }
    return parsed as KaRecord;
  }

  putRecord(record: KaRecord): void {
    assertValidRecord(record);
    this.writeAtomic(this.recordPath(record.id), canonicalJsonLine(record));
  }

  deleteRecord(id: string): void {
    rmSync(this.recordPath(id), { force: true });
  }

  /** Every record id in the corpus, sorted — the basis for a full re-index. */
  recordIds(): string[] {
    const dir = this.path("records");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length))
      .sort();
  }

  // -------------------------------------------------------------- catalog

  private catalogCache: Map<string, CatalogEntry> | undefined;
  /** Rows this process has written or deleted since it last read the catalog. */
  private readonly touched = new Set<string>();
  private readonly removed = new Set<string>();

  private loadCatalog(): Map<string, CatalogEntry> {
    if (this.catalogCache === undefined) {
      this.catalogCache = this.readCatalogFile();
    }
    return this.catalogCache;
  }

  private readCatalogFile(): Map<string, CatalogEntry> {
    const rows = this.readJson<CatalogEntry[]>(this.path("index", "catalog.json"), []);
    return new Map(rows.map((row) => [row.id, row]));
  }

  catalog(): CatalogEntry[] {
    return [...this.loadCatalog().values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  catalogEntry(id: string): CatalogEntry | undefined {
    return this.loadCatalog().get(id);
  }

  /** Insert or replace one catalog row and persist the catalog. */
  putCatalogEntry(entry: CatalogEntry): void {
    this.loadCatalog().set(entry.id, entry);
    this.touched.add(entry.id);
    this.removed.delete(entry.id);
    this.flushCatalog();
  }

  putCatalogEntries(entries: readonly CatalogEntry[]): void {
    if (entries.length === 0) return;
    const catalog = this.loadCatalog();
    for (const entry of entries) {
      catalog.set(entry.id, entry);
      this.touched.add(entry.id);
      this.removed.delete(entry.id);
    }
    this.flushCatalog();
  }

  removeCatalogEntry(id: string): void {
    if (!this.loadCatalog().delete(id)) return;
    this.removed.add(id);
    this.touched.delete(id);
    this.flushCatalog();
  }

  /**
   * Write the catalog, merging this process's changes onto what is on disk now.
   *
   * A corpus is a directory and nothing locks it, so two `ka sync` runs — or a
   * sync racing a reindex — both cached the catalog at startup and then wrote it
   * whole. The second write dropped the first run's rows: the record stayed on
   * disk and vanished from search, stats, export, feed and health, silently, with
   * only `ka reindex` to recover it.
   *
   * Re-reading here means a concurrent writer's rows survive. It does not make the
   * corpus transactional — two writes can still interleave between this read and
   * the rename — but it removes the failure that needed no race at all, just two
   * runs that started before either finished.
   */
  flushCatalog(): void {
    const merged = this.readCatalogFile();
    const mine = this.loadCatalog();
    for (const id of this.touched) {
      const entry = mine.get(id);
      if (entry !== undefined) merged.set(id, entry);
    }
    for (const id of this.removed) merged.delete(id);
    this.catalogCache = merged;
    this.touched.clear();
    this.removed.clear();
    this.writeJson(this.path("index", "catalog.json"), this.catalog());
  }

  // ---------------------------------------------------------------- index

  loadShard(shard: string): IndexShard {
    assertSafeKey(shard, "index shard");
    return this.readJson<IndexShard>(this.path("index", "tokens", `${shard}.json`), {});
  }

  saveShard(shard: string, data: IndexShard): void {
    assertSafeKey(shard, "index shard");
    const path = this.path("index", "tokens", `${shard}.json`);
    if (Object.keys(data).length === 0) {
      rmSync(path, { force: true });
      return;
    }
    this.writeJson(path, data);
  }

  /** Every shard file present, sorted — used by a full index rebuild and by stats. */
  shardNames(): string[] {
    const dir = this.path("index", "tokens");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length))
      .sort();
  }

  // ------------------------------------------------------------ artifacts

  loadArtifact<T>(name: string): T | undefined {
    assertSafeKey(name, "artifact name");
    const path = this.path("artifacts", `${name}.json`);
    if (!existsSync(path)) return undefined;
    return this.readJson<T | undefined>(path, undefined);
  }

  saveArtifact(name: string, value: unknown): void {
    assertSafeKey(name, "artifact name");
    this.writeJson(this.path("artifacts", `${name}.json`), value);
  }

  // ----------------------------------------------------------- embeddings

  loadEmbeddings(): EmbeddingSet | undefined {
    const path = this.path("index", "embeddings.json");
    if (!existsSync(path)) return undefined;
    return this.readJson<EmbeddingSet>(path, { model: "", dimensions: 0, vectors: {} });
  }

  saveEmbeddings(set: EmbeddingSet): void {
    this.writeJson(this.path("index", "embeddings.json"), set);
  }

  // ---------------------------------------------------------------- state

  getSourceState(source: string): SourceState {
    assertSafeKey(source, "source key");
    return this.readJson<SourceState>(this.path("state", `${source}.json`), {
      source,
      http_cache: {},
    });
  }

  putSourceState(state: SourceState): void {
    assertSafeKey(state.source, "source key");
    this.writeJson(this.path("state", `${state.source}.json`), state);
  }

  sourceStateKeys(): string[] {
    const dir = this.path("state");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length))
      .sort();
  }
}
