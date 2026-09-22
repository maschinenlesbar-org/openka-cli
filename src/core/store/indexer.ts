// Keeping the catalog and the inverted index in step with the records.
//
// Indexing is incremental: adding a record loads only the shards its own tokens
// live in. Removing one uses the catalog row to find the same shards again, so a
// deletion never has to scan all 256 of them.

import type { KaRecord } from "../models/schema.js";
import type { CatalogEntry, CatalogStore, IndexStore, RecordStore } from "./store.js";
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

/** Build the catalog row for a record. Pure, so the projection is unit-testable. */
export function toCatalogEntry(record: KaRecord, terms: number): CatalogEntry {
  const parties = [
    ...new Set(
      record.askers
        .map((asker) => asker.party?.trim().toLowerCase())
        .filter((party): party is string => party !== undefined && party !== ""),
    ),
  ].sort();
  // Dated by when it was asked — see `applyWindow` for why that, not the answer.
  const year = yearOf(record.dates.submitted) ?? yearOf(record.dates.answered);
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
    terms,
  };
  if (record.dates.submitted !== undefined) entry.submitted = record.dates.submitted;
  if (record.dates.answered !== undefined) entry.answered = record.dates.answered;
  if (year !== undefined) entry.year = year;
  return entry;
}

function yearOf(date: string | undefined): number | undefined {
  if (date === undefined) return undefined;
  const year = Number(date.slice(0, 4));
  return Number.isInteger(year) ? year : undefined;
}

/** The three roles indexing touches: the catalog, the shards and the records. */
export type IndexTarget = CatalogStore & IndexStore & RecordStore;

/** Add or replace a record's postings and catalog row. */
export function indexRecord(store: IndexTarget, record: KaRecord): void {
  unindexRecord(store, record.id);
  const counts = termFrequencies(indexableFields(record));
  const byShard = new Map<string, [string, number][]>();
  for (const [token, tf] of counts) {
    const shard = shardOf(token);
    const bucket = byShard.get(shard) ?? [];
    bucket.push([token, tf]);
    byShard.set(shard, bucket);
  }
  for (const [shard, tokens] of [...byShard].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const data = store.loadShard(shard);
    for (const [token, tf] of tokens) {
      const postings: Posting[] = data[token] ?? [];
      postings.push([record.id, tf]);
      postings.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      data[token] = postings;
    }
    store.saveShard(shard, data);
  }
  store.putCatalogEntry(toCatalogEntry(record, counts.size));
}

/**
 * Remove a record's postings. Reads the stored record to recover its token set;
 * when the record is already gone, falls back to scanning every shard, which is
 * slower but keeps the index honest rather than leaving dangling postings behind.
 */
export function unindexRecord(store: IndexTarget, id: string): void {
  if (store.catalogEntry(id) === undefined) return;
  const record = store.getRecord(id);
  const shards =
    record !== undefined
      ? [...new Set([...termFrequencies(indexableFields(record)).keys()].map(shardOf))].sort()
      : store.shardNames();
  for (const shard of shards) {
    const data = store.loadShard(shard);
    let changed = false;
    for (const token of Object.keys(data)) {
      const postings = data[token] as Posting[];
      const kept = postings.filter(([docId]) => docId !== id);
      if (kept.length !== postings.length) {
        changed = true;
        if (kept.length === 0) delete data[token];
        else data[token] = kept;
      }
    }
    if (changed) store.saveShard(shard, data);
  }
  store.removeCatalogEntry(id);
}

/** Drop and rebuild the whole index from the records on disk. */
export function reindexAll(store: IndexTarget): number {
  for (const shard of store.shardNames()) store.saveShard(shard, {});
  for (const entry of store.catalog()) store.removeCatalogEntry(entry.id);
  let count = 0;
  for (const id of store.recordIds()) {
    const record = store.getRecord(id);
    if (record === undefined) continue;
    indexRecord(store, record);
    count++;
  }
  return count;
}
