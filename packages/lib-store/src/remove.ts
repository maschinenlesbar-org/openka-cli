// `ka rm`: take records out of a corpus the way `ka` put them in — under the lock,
// with their catalog rows and index postings (issue #28).
//
// Without it, getting rid of 32 records with stale ids meant moving their files out of
// `records/` by hand and running `ka reindex`: a write behind `ka`'s back, with no
// lock, and nothing between the move and the rebuild to stop a search from listing
// records that were gone.
//
// The archived documents stay unless asked for: one blob can belong to several
// records (Berlin files question and answer in one PDF), and a document is the one
// thing a corpus cannot always fetch again. `blobs` removes only what no record
// that stays refers to. `to` moves instead of deleting, so a removal can be undone
// by moving the files back and running `ka reindex`.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { OpenKaError, StoreError, UsageError } from "@maschinenlesbar.org/openka-lib-errors";
import type { KaRecord } from "@maschinenlesbar.org/openka-lib-models";
import { reindexAll, unindexRecord } from "./indexer.js";
import { withCorpusLock, type Store } from "./store.js";
import { blobsApart } from "./volume.js";

/**
 * From this many records on, the index is rebuilt once (`reindexAll`) instead of each
 * record's postings being taken out of the shards it touches: one record touches 130–180
 * of the 256 shards, so the rebuild is the cheaper of the two well before a thousand.
 */
export const REMOVE_REBUILD_AT = 50;

/** A corpus `removeRecords` works on: the in-memory double too, and a file store's root for `to` and a shared blob store. */
export type RemovableStore = Store & { readonly root?: string; readonly blobsRoot?: string };

export interface RemoveOptions {
  /** The records to remove; every one must exist, or nothing is removed. */
  ids: readonly string[];
  /** Also remove the archived documents of these records that no remaining record refers to. */
  blobs?: boolean;
  /** Move the files under this directory (`records/`, `blobs/`) instead of deleting them. */
  to?: string;
  /** Say what would be removed, and change nothing. */
  dryRun?: boolean;
}

export interface RemoveReport {
  dry_run: boolean;
  /** The records removed (or that would be), sorted. */
  removed: string[];
  /** Of those, the ones a person had marked `human_verified`. */
  human_verified: string[];
  /** Blobs removed, by digest — only with `blobs` (or `removeOrphanedBlobs`). */
  blobs_removed: string[];
  /** Their size in bytes. */
  blob_bytes: number;
  /** Blobs of the removed records kept because a record that stays refers to them. */
  blobs_shared: number;
  /** Where the files went, when they were moved. */
  moved_to?: string;
  /** Records that could not be read: their file was removed, and the index rebuilt. */
  unreadable: string[];
}

/**
 * Remove records, their catalog rows and their index postings — and, with `blobs`,
 * the archived documents only they referred to. Holds the corpus lock. Refuses
 * (`OpenKaError`) when an id is not in the corpus, and removes nothing then.
 */
export function removeRecords(store: RemovableStore, options: RemoveOptions): RemoveReport {
  const ids = [...new Set(options.ids)].sort();
  if (ids.length === 0) throw new UsageError("Name at least one record to remove.");
  const run = (): RemoveReport => {
    const missing = ids.filter((id) => !store.hasRecord(id));
    if (missing.length > 0) {
      throw new OpenKaError(`No record ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? ` and ${missing.length - 10} more` : ""} in the corpus; nothing was removed`);
    }
    const to = options.to === undefined ? undefined : target(store, options.to);
    if (options.blobs === true) assertOwnBlobs(store, to);

    const records = new Map<string, KaRecord | undefined>();
    const unreadable: string[] = [];
    for (const id of ids) {
      try {
        records.set(id, store.getRecord(id));
      } catch (err) {
        if (!(err instanceof StoreError)) throw err;
        records.set(id, undefined);
        unreadable.push(id);
      }
    }
    const report: RemoveReport = {
      dry_run: options.dryRun === true,
      removed: ids,
      human_verified: ids.filter((id) => records.get(id)?.extraction.review_status === "human_verified"),
      blobs_removed: [],
      blob_bytes: 0,
      blobs_shared: 0,
      ...(to === undefined ? {} : { moved_to: to }),
      unreadable,
    };

    // The removed records' blobs that no other record refers to. Reading every record
    // that stays is the only way to know; an unreadable one keeps every blob, since
    // what it refers to cannot be told.
    let orphans: string[] = [];
    if (options.blobs === true) {
      const theirs = new Set([...records.values()].flatMap((record) => digestsOf(record)));
      const kept = referencedDigests(store, new Set(ids));
      orphans = kept === undefined ? [] : [...theirs].filter((digest) => !kept.has(digest) && store.hasBlob(digest)).sort();
      report.blobs_shared = theirs.size - orphans.length;
      report.blobs_removed = orphans;
      report.blob_bytes = orphans.reduce((sum, digest) => sum + blobSize(store, digest), 0);
    }
    if (options.dryRun === true) return report;

    const rebuild = ids.length >= REMOVE_REBUILD_AT || unreadable.length > 0;
    for (const id of ids) {
      if (to !== undefined) moveOut(join(to, "records", `${id}.json`), store.getRecordBytes(id));
      const record = records.get(id);
      if (!rebuild && record !== undefined) unindexRecord(store, id, record);
      store.deleteRecord(id);
    }
    if (rebuild) reindexAll(store);
    forgetVectors(store, new Set(ids));
    for (const digest of orphans) {
      if (to !== undefined) moveOut(join(to, "blobs", digest.slice(0, 2), `${digest}.bin`), store.getBlob(digest));
      store.deleteBlob(digest);
    }
    return report;
  };
  return options.dryRun === true ? run() : withCorpusLock(store, `rm ${ids.length === 1 ? ids[0] : `${ids.length} records`}`, run);
}

/**
 * Every blob that no record refers to: documents left behind by records removed by
 * hand, or by a record whose document was replaced. `undefined` when a record could
 * not be read, since its documents cannot be told apart then.
 */
export function orphanedBlobs(store: Pick<Store, "recordIds" | "getRecord" | "blobDigests">): string[] | undefined {
  const referenced = referencedDigests(store, new Set());
  return referenced === undefined ? undefined : store.blobDigests().filter((digest) => !referenced.has(digest));
}

/** Remove (or, with `to`, move) every orphaned blob (`orphanedBlobs`). Holds the corpus lock. */
export function removeOrphanedBlobs(store: RemovableStore, options: Omit<RemoveOptions, "ids" | "blobs"> = {}): RemoveReport {
  const run = (): RemoveReport => {
    const to = options.to === undefined ? undefined : target(store, options.to);
    assertOwnBlobs(store, to);
    const orphans = orphanedBlobs(store);
    if (orphans === undefined) throw new StoreError("A record could not be read, so which documents no record refers to cannot be told; `ka doctor` names it");
    const report: RemoveReport = {
      dry_run: options.dryRun === true,
      removed: [],
      human_verified: [],
      blobs_removed: orphans,
      blob_bytes: orphans.reduce((sum, digest) => sum + blobSize(store, digest), 0),
      blobs_shared: 0,
      ...(to === undefined ? {} : { moved_to: to }),
      unreadable: [],
    };
    if (options.dryRun === true) return report;
    for (const digest of orphans) {
      if (to !== undefined) moveOut(join(to, "blobs", digest.slice(0, 2), `${digest}.bin`), store.getBlob(digest));
      store.deleteBlob(digest);
    }
    return report;
  };
  return options.dryRun === true ? run() : withCorpusLock(store, "rm --orphaned-documents", run);
}

function digestsOf(record: KaRecord | undefined): string[] {
  return (record?.source_documents ?? []).flatMap((document) => (document.sha256 === undefined ? [] : [document.sha256]));
}

/** The digests the records outside `except` refer to, or undefined when one cannot be read. */
function referencedDigests(store: Pick<Store, "recordIds" | "getRecord">, except: ReadonlySet<string>): Set<string> | undefined {
  const referenced = new Set<string>();
  for (const id of store.recordIds()) {
    if (except.has(id)) continue;
    let record: KaRecord | undefined;
    try {
      record = store.getRecord(id);
    } catch (err) {
      if (err instanceof StoreError) return undefined;
      throw err;
    }
    for (const digest of digestsOf(record)) referenced.add(digest);
  }
  return referenced;
}

/** A blob's size: its file's, without reading it, else its bytes'. */
export function blobSize(store: Pick<Store, "blobPath" | "getBlob">, digest: string): number {
  try {
    return statSync(store.blobPath(digest)).size;
  } catch {
    try {
      return store.getBlob(digest).length;
    } catch {
      return 0;
    }
  }
}

/**
 * Deleting a blob from a store named apart from the corpus (`--blobs <dir>`) could
 * take another corpus's documents with it: ka sees only this corpus's records. Moving
 * them (`to`) is reversible, and allowed.
 */
function assertOwnBlobs(store: RemovableStore, to: string | undefined): void {
  if (to !== undefined || store.root === undefined || store.blobsRoot === undefined) return;
  if (blobsApart({ root: store.root, blobsRoot: store.blobsRoot })) {
    throw new UsageError(
      `The archived documents are kept apart from the corpus, in ${store.blobsRoot}, which another corpus may share — ` +
        "ka cannot see its records. Move them instead (`ka rm --move-to <dir>`), or remove them by hand.",
    );
  }
}

/** The `to` directory, absolute, refused inside the corpus or its blob store. */
function target(store: RemovableStore, to: string): string {
  const absolute = resolve(to);
  for (const inside of [store.root, store.blobsRoot]) {
    if (inside === undefined) continue;
    const rel = relative(resolve(inside), absolute);
    if (rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) {
      throw new UsageError(`${to} is inside the corpus (${inside}); name a directory outside it.`);
    }
  }
  return absolute;
}

/** Write `bytes` to `path` before the original goes; a different file already there is refused. */
function moveOut(path: string, bytes: Buffer | undefined): void {
  if (bytes === undefined) return;
  if (existsSync(path)) {
    if (readFileSync(path).equals(bytes)) return;
    throw new StoreError(`${path} already exists with other content; nothing was overwritten`);
  }
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes, { flag: "wx" });
  } catch (err) {
    throw new StoreError(`Could not write ${path}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}

/** Drop the frozen vectors of removed records, so `--like` does not keep them. */
function forgetVectors(store: Pick<Store, "loadEmbeddings" | "saveEmbeddings">, ids: ReadonlySet<string>): void {
  const set = store.loadEmbeddings();
  if (set === undefined || !Object.keys(set.vectors).some((id) => ids.has(id))) return;
  store.saveEmbeddings({ ...set, vectors: Object.fromEntries(Object.entries(set.vectors).filter(([id]) => !ids.has(id))) });
}
