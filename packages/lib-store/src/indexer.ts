// Keeping the catalog and the inverted index in step with the records.
//
// Indexing is incremental: adding a record loads only the shards its own tokens
// live in. Removing one uses the catalog row to find the same shards again, so a
// deletion never has to scan all 256 of them.

import { StoreError } from "@maschinenlesbar.org/openka-lib-errors";
import type { KaRecord } from "@maschinenlesbar.org/openka-lib-models";
import { withCorpusLock, type CatalogEntry, type CatalogStore, type IndexStore, type LockableStore, type PostingChange, type RecordStore } from "./store.js";
import type { IndexShard } from "./fts.js";
import { shardOf, termFrequencies, type Posting } from "./fts.js";

/** The text of a record that is worth searching, as one string per field group. */
export function indexableFields(record: KaRecord): { title: string; body: string; extra: string[] } {
  const extra: string[] = [record.reference];
  for (const asker of record.askers) {
    extra.push(asker.name);
    if (asker.party) extra.push(asker.party);
  }
  if (record.answered_by.ministry) extra.push(record.answered_by.ministry);
  const qaText = record.qa
    .map((pair) => [pair.question ?? "", pair.answer ?? ""].join(" "))
    .join(" ")
    .trim();
  // Prefer the parsed Q/A text over full_text where both exist: it is the same
  // words minus the cover page and the boilerplate footer.
  const body = qaText !== "" ? qaText : (record.full_text ?? "");
  return { title: record.title, body, extra };
}

/**
 * The kind of an abstained field: its path with every index dropped, so
 * `qa[3].answer` and `qa[7].answer` are one kind, `qa[].answer`. Four hundred records
 * abstaining on the same kind of field are most likely one rule failing on one
 * layout, not four hundred problems.
 */
export function abstainedFieldKind(path: string): string {
  return path.replace(/\[\d+\]/g, "[]");
}

/** Build the catalog row for a record. Pure, so the projection is unit-testable. */
export function toCatalogEntry(record: KaRecord, terms: number): CatalogEntry {
  const parties = [
    ...new Set(
      record.askers
        .map((asker) => asker.party?.trim().toLowerCase())
        .filter((party): party is string => party !== undefined && party !== ""),
    ),
  ].sort();
  // Dated by when it was asked — see `applyWindow` for why that, not the answer. A
  // record whose question date is unknown has no year: placing it at its answer's
  // year put a February question in May's window (finding 01#2).
  const year = yearOf(record.dates.submitted);
  const entry: CatalogEntry = {
    id: record.id,
    parliament: record.parliament,
    reference: record.reference,
    legislative_period: record.legislative_period,
    title: record.title,
    parties,
    review_status: record.extraction.review_status,
    tier: record.extraction.tier,
    abstained: record.extraction.abstained_fields.length,
    questions: record.qa.length,
    extractor_version: record.extraction.extractor_version,
    terms,
  };
  const labels = new Map<string, string>();
  for (const asker of record.askers) {
    const label = asker.party?.trim();
    if (label !== undefined && label !== "" && !labels.has(label.toLowerCase())) labels.set(label.toLowerCase(), label);
  }
  if (labels.size > 0) entry.party_labels = [...labels.values()];
  const ministry = record.answered_by.ministry?.trim();
  if (ministry !== undefined && ministry !== "") entry.ministry = ministry;
  if (record.dates.submitted !== undefined) entry.submitted = record.dates.submitted;
  if (record.dates.answered !== undefined) entry.answered = record.dates.answered;
  if (year !== undefined) entry.year = year;
  if (record.extraction.abstained_fields.length > 0) {
    const kinds: Record<string, number> = {};
    for (const path of [...record.extraction.abstained_fields].sort()) {
      const kind = abstainedFieldKind(path);
      kinds[kind] = (kinds[kind] ?? 0) + 1;
    }
    entry.abstained_fields = Object.fromEntries(Object.entries(kinds).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  }
  return entry;
}

function yearOf(date: string | undefined): number | undefined {
  if (date === undefined) return undefined;
  const year = Number(date.slice(0, 4));
  return Number.isInteger(year) ? year : undefined;
}

/** The roles indexing touches: the catalog, the shards and the records — and the lock, where there is one. */
export type IndexTarget = CatalogStore & IndexStore & RecordStore & LockableStore;

/**
 * Add or replace a record's postings and catalog row.
 *
 * Idempotent per shard: a posting this record already has is replaced, not added
 * twice. That matters after an interrupted sync, which wrote a record's postings
 * but never its catalog row — `unindexRecord` finds nothing to remove for a record
 * the catalog does not know, and re-indexing it used to double every posting.
 *
 * `previous` is the record whose postings are in the index now, when the caller
 * has already replaced the file: a re-extraction writes the new record first, and
 * reading the token set back from disk then found the *new* text, so the words
 * only the old document had kept pointing at the record.
 */
export function indexRecord(store: IndexTarget, record: KaRecord, previous?: KaRecord): void {
  unindexRecord(store, record.id, previous);
  const counts = termFrequencies(indexableFields(record));
  const byShard = new Map<string, Posting[]>();
  for (const [token, tf] of counts) {
    const shard = shardOf(token);
    const bucket = byShard.get(shard) ?? [];
    bucket.push([token, tf]);
    byShard.set(shard, bucket);
  }
  for (const [shard, postings] of [...byShard].sort(([a], [b]) => (a < b ? -1 : 1))) {
    changePostings(store, shard, { kind: "add", id: record.id, postings });
  }
  store.putCatalogEntry(toCatalogEntry(record, counts.size));
}

/**
 * Remove a record's postings. Reads the stored record to recover its token set —
 * or takes `previous`, the record the index was built from, when the file has
 * already been replaced; when the record is gone, falls back to scanning every
 * shard, which is slower but keeps the index honest rather than leaving dangling
 * postings behind. Without a catalog row and without `previous` there is nothing
 * known to remove.
 */
export function unindexRecord(store: IndexTarget, id: string, previous?: KaRecord): void {
  const catalogued = store.catalogEntry(id) !== undefined;
  if (!catalogued && previous === undefined) return;
  const record = previous ?? store.getRecord(id);
  if (record !== undefined) {
    const byShard = new Map<string, string[]>();
    for (const token of termFrequencies(indexableFields(record)).keys()) {
      const shard = shardOf(token);
      byShard.set(shard, [...(byShard.get(shard) ?? []), token]);
    }
    for (const [shard, tokens] of [...byShard].sort(([a], [b]) => (a < b ? -1 : 1))) changePostings(store, shard, { kind: "remove", id, tokens });
  } else {
    // What the record held is unknown: every shard is searched for it.
    for (const shard of store.shardNames()) changePostings(store, shard, { kind: "remove", id });
  }
  if (catalogued) store.removeCatalogEntry(id);
}

/**
 * Apply `change` to `shard`: queued for the end of the batch where the store keeps a
 * queue (`IndexStore.queuePostings`), else at once. Storing one record touched nearly
 * every one of the 256 shards and rewrote each in full — 202 MB for one Sachsen-Anhalt
 * paper, ten seconds a record on a USB stick, and more the bigger the corpus (issue #30).
 */
function changePostings(store: IndexStore, shard: string, change: PostingChange): void {
  if (store.queuePostings?.(shard, change) === true) return;
  const data = store.loadShard(shard);
  if (applyPostingChanges(data, [change])) store.saveShard(shard, data);
}

/**
 * Apply `changes`, in order, to a shard's postings. Returns whether anything changed.
 * Postings stay sorted by record id, as the incremental path and a rebuild leave them.
 */
export function applyPostingChanges(data: IndexShard, changes: readonly PostingChange[]): boolean {
  let changed = false;
  for (const change of changes) {
    if (change.kind === "remove") {
      for (const token of change.tokens ?? Object.keys(data)) {
        const postings = data[token];
        if (postings === undefined) continue;
        const kept = postings.filter(([docId]) => docId !== change.id);
        if (kept.length === postings.length) continue;
        changed = true;
        if (kept.length === 0) delete data[token];
        else data[token] = kept;
      }
    } else {
      for (const [token, tf] of change.postings) {
        const postings: Posting[] = (data[token] ?? []).filter(([docId]) => docId !== change.id);
        postings.push([change.id, tf]);
        postings.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        data[token] = postings;
        changed = true;
      }
    }
  }
  return changed;
}

/** Where the catalog and the record files disagree — see `catalogGaps`. */
export interface CatalogGaps {
  /** Record files with no catalog row: on disk, invisible to search, stats and export. */
  uncatalogued: string[];
  /** Catalog rows with no record file: listed and counted, but nothing to read. */
  missingFiles: string[];
}

/**
 * Compare the catalog with the record files, both directions. An interrupted sync
 * (before 2026-10) or a record file deleted by hand leaves them apart, and neither
 * side can see it from where it stands: search reads only the catalog, `ka verify
 * --all` only the files. `ka reindex` closes both gaps.
 */
export function catalogGaps(store: Pick<IndexTarget, "catalog" | "recordIds">): CatalogGaps {
  const files = new Set(store.recordIds());
  const rows = new Set(store.catalog().map((entry) => entry.id));
  return {
    uncatalogued: [...files].filter((id) => !rows.has(id)).sort(),
    missingFiles: [...rows].filter((id) => !files.has(id)).sort(),
  };
}

/**
 * Drop and rebuild the whole index from the records on disk.
 *
 * Batched, because doing it a record at a time is what made indexing expensive:
 * `indexRecord` reads, parses, serialises and atomically writes one file per shard
 * the record's tokens touch, and a real record touches 130–182 of the 256. Two
 * hundred records took ten seconds, 96% of it shard I/O. Grouping every record's
 * postings first turns that into one write per shard for the whole corpus, and one
 * catalog write instead of one per record.
 *
 * Holds the corpus lock (`CorpusLockedError` while a sync writes).
 */
export function reindexAll(
  store: IndexTarget,
  options: {
    /**
     * Called for a record that cannot be read, which is then left out of the index.
     * Without it the first such record aborts the rebuild, as it always did.
     */
    onUnreadable?: (id: string, error: StoreError) => void;
  } = {},
): number {
  return withCorpusLock(store, "reindex", () => rebuild(store, options));
}

function rebuild(store: IndexTarget, options: { onUnreadable?: (id: string, error: StoreError) => void }): number {
  // Nothing is removed before the new index is complete in memory: deleting every
  // shard first meant a rebuild killed part-way left a corpus whose catalog listed
  // every record while every keyword search answered "No matches.".
  const previousShards = store.shardNames();

  const byShard = new Map<string, IndexShard>();
  const rows: CatalogEntry[] = [];
  let count = 0;
  for (const id of store.recordIds()) {
    let record: KaRecord | undefined;
    try {
      record = store.getRecord(id);
    } catch (err) {
      if (options.onUnreadable === undefined || !(err instanceof StoreError)) throw err;
      options.onUnreadable(id, err);
      continue;
    }
    if (record === undefined) continue;
    const counts = termFrequencies(indexableFields(record));
    for (const [token, tf] of counts) {
      const shard = shardOf(token);
      const data = byShard.get(shard) ?? {};
      (data[token] ??= []).push([record.id, tf]);
      byShard.set(shard, data);
    }
    rows.push(toCatalogEntry(record, counts.size));
    count++;
  }

  for (const [shard, data] of [...byShard].sort(([a], [b]) => (a < b ? -1 : 1))) {
    // Postings stay sorted by document id, as the incremental path leaves them.
    for (const token of Object.keys(data)) {
      (data[token] as Posting[]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    }
    store.saveShard(shard, data);
  }
  // Each shard is replaced whole and atomically above; only then do the shards no
  // record needs any more go.
  for (const shard of previousShards) {
    if (!byShard.has(shard)) store.saveShard(shard, {});
  }
  // The old catalog is discarded unread: a corrupt one is exactly what a rebuild
  // is for.
  store.replaceCatalog(rows);
  return count;
}

/**
 * Record that a person checked a record against its source: `review_status`
 * becomes `human_verified` in the record *and* its catalog row, which search,
 * the review queue and `verifyRecord` read. Setting it and calling `putRecord`
 * alone left the catalog saying `needs_review`. The abstained fields are
 * unchanged — the holes were checked, not filled. `undefined` when there is no
 * such record.
 */
export function markHumanVerified(store: IndexTarget, id: string): KaRecord | undefined {
  return withCorpusLock(store, "review --mark-verified", () => {
    const record = store.getRecord(id);
    if (record === undefined) return undefined;
    record.extraction.review_status = "human_verified";
    store.putRecord(record);
    indexRecord(store, record);
    return record;
  });
}
