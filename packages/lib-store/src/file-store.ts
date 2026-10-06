// The corpus on disk:
//
//   <root>/
//     blobs/<sha[0:2]>/<sha>.bin        content-addressed source documents
//     records/<id>.json                 canonical records, one file each
//     index/catalog.json                denormalised rows for filtering + listing
//     index/tokens/<shard>.json         inverted index shards (256 of them)
//     index/embeddings.json             frozen vectors, only if the factory shipped some
//     state/<source>.json               per-source sync + conditional-request state
//     lock                              held while a run writes: pid, host and purpose
//
// Everything is plain JSON in canonical form, so a corpus diffs cleanly in git, can
// be inspected with `cat`, and — crucially for the reproducibility claim — is
// byte-identical for the same inputs regardless of the machine that wrote it.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CorpusLockedError, MissingCorpusError, StoreError, assertValid, type Problem } from "@maschinenlesbar.org/openka-lib-errors";
import { canonicalJsonLine } from "@maschinenlesbar.org/openka-lib-repro";
import { isSha256, sha256 } from "@maschinenlesbar.org/openka-lib-repro";
import { assertValidRecord } from "@maschinenlesbar.org/openka-lib-models";
import type { KaRecord } from "@maschinenlesbar.org/openka-lib-models";
import type { IndexShard } from "./fts.js";
import type { CatalogEntry, EmbeddingSet, SourceState, Store } from "./store.js";

/** Record ids and source keys reach the filesystem, so they are strictly checked. */
const SAFE_KEY = /^[a-z0-9][a-z0-9._-]*$/;

/** Whether `value` can be a record id or source key — the rule every path is built under. */
export function isSafeKey(value: string): boolean {
  return SAFE_KEY.test(value) && !value.includes("..");
}

/** Why a record id is refused: the reason `recordIdProblem` gives and `ka` prints. */
export const RECORD_ID_REASON =
  "Not a record id: expected lower-case letters, digits, '.', '_' and '-', like berlin-19-10006.";

/**
 * Why `value` cannot be a record id, or `undefined` when it can: the store's key
 * rule (`isSafeKey`), since an id becomes a file name. "BERLIN-19-10006" and
 * "../x" are a caller's mistake, not a damaged corpus.
 */
export const recordIdProblem: Problem<string> = (value) =>
  typeof value === "string" && isSafeKey(value) ? undefined : RECORD_ID_REASON;

/**
 * Throw `OpenKaValidationError` ("Invalid id: Not a record id: …") for an id that
 * fails `recordIdProblem`. Every `FileStore` method that takes a record id calls
 * it before touching a file; an unsafe name found inside the corpus stays a
 * `StoreError` (`recordIds`).
 */
export function assertRecordId(id: string): void {
  assertValid("id", id, recordIdProblem);
}

/**
 * Files the operating system puts beside ours, which the store never wrote and
 * never reads: macOS's AppleDouble companions (`._<name>`, written next to every
 * file on a volume that cannot store extended attributes — FAT32, exFAT, many
 * network shares — and by `cp -R` onto one) and Finder's `.DS_Store`. A corpus on a
 * USB stick holds hundreds of them, and the first one in `records/` used to stop
 * every command with "Unsafe record file". They are skipped, and the store keeps
 * their paths so a caller can say so once (`FileStore.ignoredFiles`). Neither name
 * can be a record id or a source key, which start with a letter or a digit.
 */
export function isPlatformFile(name: string): boolean {
  return name.startsWith("._") || name === ".DS_Store";
}

function assertSafeKey(value: string, what: string): void {
  if (!isSafeKey(value)) {
    throw new StoreError(`Unsafe ${what} "${value}": expected [a-z0-9][a-z0-9._-]*`);
  }
}

/** Why a parsed catalog is not a list of catalog rows, or undefined when it is one. */
function catalogProblem(rows: unknown): string | undefined {
  if (!Array.isArray(rows)) return "not a list of rows";
  for (const [index, row] of rows.entries()) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) return `row ${index} is not an object`;
    const entry = row as Record<string, unknown>;
    if (typeof entry["id"] !== "string" || !SAFE_KEY.test(entry["id"]) || entry["id"].includes("..")) {
      return `row ${index} has no safe record id`;
    }
    for (const key of ["parliament", "reference", "title", "review_status", "tier"]) {
      if (typeof entry[key] !== "string") return `row ${index} (${entry["id"]}) has no ${key}`;
    }
    for (const key of ["legislative_period", "abstained", "terms"]) {
      if (typeof entry[key] !== "number") return `row ${index} (${entry["id"]}) has no ${key}`;
    }
    if (!Array.isArray(entry["parties"])) return `row ${index} (${entry["id"]}) has no parties`;
  }
  return undefined;
}

export class FileStore implements Store {
  readonly root: string;

  /**
   * Open the corpus at `root`, or create it on the first write. For a writer
   * (`sync`, a test fixture): a directory that is not there yet is where the corpus
   * will be. A reader wants `FileStore.open` instead.
   */
  constructor(root: string) {
    this.root = resolve(root);
  }

  /**
   * Open the corpus at `root` for reading: it must already exist. A missing
   * directory throws `MissingCorpusError`, a path that is not a directory
   * `StoreError` (both exit 3 in `ka`). `new FileStore` on the same path answers
   * an empty corpus — no records, no matches — which for a mistyped path is the
   * wrong answer, indistinguishable from a corpus with nothing in it. Nothing is
   * created.
   */
  static open(root: string): FileStore {
    const resolved = resolve(root);
    let isDirectory: boolean;
    try {
      isDirectory = statSync(resolved).isDirectory();
    } catch (err) {
      if ((err as { code?: unknown }).code === "ENOENT") throw new MissingCorpusError(resolved);
      const reason = err instanceof Error ? err.message : String(err);
      throw new StoreError(`Could not open the corpus at ${resolved}: ${reason}`, { cause: err });
    }
    if (!isDirectory) throw new StoreError(`${resolved} is not a directory, so it cannot be a corpus.`);
    return new FileStore(resolved);
  }

  // ----------------------------------------------------------------- lock

  /** How many times this object holds the lock: it is re-entrant per store. */
  private locks = 0;

  /**
   * Take the corpus for writing. The lock is a file created exclusively (`wx`),
   * holding the pid, the host and the purpose of the run that took it. A second
   * writer — another `ka sync`, a `ka reindex`, another `FileStore` in the same
   * process — gets `CorpusLockedError` instead of interleaving its writes.
   *
   * A lock left behind by a run that was killed is taken over when it names this
   * host and a process that no longer exists. A lock from another host (a corpus
   * on a network share) cannot be checked, so it is never taken over: the error
   * names the file to delete.
   */
  lock(purpose: string): () => void {
    if (this.locks > 0) {
      this.locks++;
      return this.releaseOnce();
    }
    const path = this.path("lock");
    const mine = JSON.stringify({ host: hostname(), pid: process.pid, purpose }) + "\n";
    mkdirSync(this.root, { recursive: true });
    for (let attempt = 0; ; attempt++) {
      try {
        writeFileSync(path, mine, { flag: "wx" });
        break;
      } catch (err) {
        if ((err as { code?: unknown }).code !== "EEXIST") {
          const reason = err instanceof Error ? err.message : String(err);
          throw new StoreError(`Could not lock the corpus at ${this.root}: ${reason}`, { cause: err });
        }
        const holder = readLock(path);
        if (attempt === 0 && holder !== undefined && isStale(holder)) {
          rmSync(path, { force: true });
          continue;
        }
        throw new CorpusLockedError(path, describeHolder(holder));
      }
    }
    this.locks = 1;
    // The cheapest honest probe there is: the lock file was just written, and on a
    // volume without extended attributes macOS writes its `._lock` companion at the
    // same moment. Deleting the lock deletes the companion too.
    if (existsSync(this.path("._lock"))) this.appleDouble = true;
    return this.releaseOnce();
  }

  private appleDouble = false;

  /**
   * Whether macOS writes an AppleDouble companion (`._<name>`) beside every file
   * this corpus holds — a FAT32 or exFAT volume. Known once `lock()` has run; false
   * before that, and on every other system.
   */
  get writesAppleDouble(): boolean {
    return this.appleDouble;
  }

  private readonly ignored = new Set<string>();

  /** Platform files (`isPlatformFile`) the listings have skipped so far, as paths, sorted. */
  ignoredFiles(): string[] {
    return [...this.ignored].sort();
  }

  /**
   * The `<key>.json` names in `dir`, without the extension and sorted — every
   * listing of the corpus goes through here, so a platform file is skipped (and
   * remembered) in each of them alike.
   */
  private listJsonKeys(...parts: string[]): string[] {
    const dir = this.path(...parts);
    if (!existsSync(dir)) return [];
    const keys: string[] = [];
    for (const name of readdirSync(dir)) {
      if (isPlatformFile(name)) {
        this.ignored.add(join(dir, name));
        continue;
      }
      if (name.endsWith(".json")) keys.push(name.slice(0, -".json".length));
    }
    return keys.sort();
  }

  private releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.locks--;
      if (this.locks === 0) rmSync(this.path("lock"), { force: true });
    };
  }

  // ---------------------------------------------------------------- paths

  private path(...parts: string[]): string {
    return join(this.root, ...parts);
  }

  /**
   * Where the blob for `digest` lives — built, not checked: the file may be
   * missing or corrupt. `getBlob` checks the bytes, and `archivedDocument` hands
   * out a path only after checking them.
   */
  blobPath(digest: string): string {
    if (!isSha256(digest)) throw new StoreError(`Not a sha256 digest: ${digest}`);
    return this.path("blobs", digest.slice(0, 2), `${digest}.bin`);
  }

  private recordPath(id: string): string {
    assertRecordId(id);
    return this.path("records", `${id}.json`);
  }

  // ------------------------------------------------------------- file I/O

  /**
   * Write atomically: a crash or a full disk must never leave a half-written
   * record or index shard behind, because a truncated JSON file would look like
   * corpus corruption rather than an interrupted run.
   */
  private writeAtomic(path: string, data: Buffer | string): void {
    const temporary = `${path}.tmp-${process.pid}`;
    try {
      mkdirSync(dirname(path), { recursive: true });
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
    // would only risk replacing a good blob with a truncated one — unless the file
    // there no longer hashes to its name, in which case fresh bytes repair it.
    if (!existsSync(path) || sha256(readFileSync(path)) !== digest) this.writeAtomic(path, data);
    return digest;
  }

  /**
   * The archived bytes, checked against their own name. The store is
   * content-addressed, and a blob that no longer hashes to its name is not the
   * document the record was built from: read unchecked, `ka verify` blamed the
   * extractor for "different bytes with the same version" and `ka open` handed
   * the altered file out without comment.
   */
  getBlob(digest: string): Buffer {
    const path = this.blobPath(digest);
    if (!existsSync(path)) throw new StoreError(`No blob ${digest} in ${this.root}`);
    const bytes = readFileSync(path);
    const actual = sha256(bytes);
    if (actual !== digest) {
      throw new StoreError(`The archived bytes ${path} are corrupt: they hash to ${actual}, not to their name`);
    }
    return bytes;
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
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || (parsed as { id?: unknown }).id !== id) {
      throw new StoreError(`Corrupt record ${id}: not a record stored under that id`);
    }
    return parsed as KaRecord;
  }

  putRecord(record: KaRecord): void {
    assertValidRecord(record);
    this.writeAtomic(this.recordPath(record.id), canonicalJsonLine(record));
  }

  deleteRecord(id: string): void {
    this.remove(this.recordPath(id));
  }

  /**
   * Remove a file, as a `StoreError` when it cannot be: a read-only corpus made
   * `ka reindex` fail with "Unexpected error: EACCES" (exit 1) at the first shard
   * it emptied, where every other write names the corpus problem (exit 3).
   */
  private remove(path: string): void {
    try {
      rmSync(path, { force: true });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new StoreError(`Could not remove ${path}: ${reason}`, { cause: err });
    }
  }

  /**
   * Every record id in the corpus, sorted — the basis for a full re-index. A record
   * file whose name is not a record id was not written by the store: it is a
   * `StoreError` here, so it does not reach `getRecord` as a caller's usage error —
   * except a platform file (`isPlatformFile`), which is skipped.
   */
  recordIds(): string[] {
    const dir = this.path("records");
    const ids = this.listJsonKeys("records");
    for (const id of ids) {
      if (!isSafeKey(id)) {
        throw new StoreError(`Unsafe record file "${id}.json" in ${dir}: expected [a-z0-9][a-z0-9._-]*.json`);
      }
    }
    return ids;
  }

  // -------------------------------------------------------------- catalog

  private catalogCache: Map<string, CatalogEntry> | undefined;
  /** Rows this process has written or deleted since it last read the catalog. */
  private readonly touched = new Set<string>();
  private readonly removed = new Set<string>();
  /** Open `batchCatalog` scopes; writes persist only when this is back at zero. */
  private deferring = 0;

  private loadCatalog(): Map<string, CatalogEntry> {
    if (this.catalogCache === undefined) {
      this.catalogCache = this.readCatalogFile();
    }
    return this.catalogCache;
  }

  private readCatalogFile(): Map<string, CatalogEntry> {
    const path = this.path("index", "catalog.json");
    const rows = this.readJson<unknown>(path, []);
    // Parsed is not the same as well-formed: `{"a":1}` crashed search with
    // "rows.map is not a function", and a row without a title with a TypeError —
    // both reported as an unexpected error rather than as a corpus problem.
    const problem = catalogProblem(rows);
    if (problem !== undefined) {
      throw new StoreError(`Corrupt catalog ${path}: ${problem} — \`ka reindex\` rebuilds it from the records`);
    }
    return new Map((rows as CatalogEntry[]).map((row) => [row.id, row]));
  }

  replaceCatalog(entries: readonly CatalogEntry[]): void {
    this.catalogCache = new Map(entries.map((entry) => [entry.id, entry]));
    this.touched.clear();
    this.removed.clear();
    this.writeJson(this.path("index", "catalog.json"), this.catalog());
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
    this.flushUnlessDeferred();
  }

  putCatalogEntries(entries: readonly CatalogEntry[]): void {
    if (entries.length === 0) return;
    const catalog = this.loadCatalog();
    for (const entry of entries) {
      catalog.set(entry.id, entry);
      this.touched.add(entry.id);
      this.removed.delete(entry.id);
    }
    this.flushUnlessDeferred();
  }

  removeCatalogEntry(id: string): void {
    if (!this.loadCatalog().delete(id)) return;
    this.removed.add(id);
    this.touched.delete(id);
    this.flushUnlessDeferred();
  }

  async batchCatalog<T>(work: () => Promise<T>): Promise<T> {
    this.deferring++;
    try {
      return await work();
    } finally {
      this.deferring--;
      if (this.deferring === 0 && (this.touched.size > 0 || this.removed.size > 0)) this.flushCatalog();
    }
  }

  private flushUnlessDeferred(): void {
    if (this.deferring === 0) this.flushCatalog();
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
   * runs that started before either finished. The writers that go through the
   * library (`sync`, `reindexAll`, `markHumanVerified`) now also hold `lock()`,
   * which is what keeps the index shards, written without a merge, intact.
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
      this.remove(path);
      return;
    }
    this.writeJson(path, data);
  }

  /** Every shard file present, sorted — used by a full index rebuild and by stats. */
  shardNames(): string[] {
    return this.listJsonKeys("index", "tokens");
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
    return this.listJsonKeys("state");
  }
}

interface LockHolder {
  host?: unknown;
  pid?: unknown;
  purpose?: unknown;
}

function readLock(path: string): LockHolder | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as LockHolder) : undefined;
  } catch {
    return undefined;
  }
}

/** A lock from this host whose process is gone: the run that took it was killed. */
function isStale(holder: LockHolder): boolean {
  if (holder.host !== hostname() || typeof holder.pid !== "number" || !Number.isInteger(holder.pid)) return false;
  if (holder.pid === process.pid) return false;
  try {
    process.kill(holder.pid, 0);
    return false;
  } catch (err) {
    // EPERM: the process exists and belongs to someone else — it is alive.
    return (err as { code?: unknown }).code === "ESRCH";
  }
}

function describeHolder(holder: LockHolder | undefined): string {
  if (holder === undefined) return "unreadable lock file";
  const purpose = typeof holder.purpose === "string" ? holder.purpose : "a write";
  const pid = typeof holder.pid === "number" ? `pid ${holder.pid}` : "unknown pid";
  const host = typeof holder.host === "string" ? ` on ${holder.host}` : "";
  return `${purpose}, ${pid}${host}`;
}
