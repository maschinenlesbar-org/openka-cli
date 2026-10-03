// Keyword search over the corpus: parse the query, gather postings from the index
// shards the query terms live in, apply the structured filters, rank, and return
// catalog rows. No record is loaded from disk unless a phrase has to be confirmed
// or a snippet is requested.

import { containsPhrase, normalizeWithOffsets, parseQuery, scoreTerm, shardOf, type ParsedQuery, type Posting } from "@maschinenlesbar.org/openka-lib-store";
import type { CatalogEntry, Store } from "@maschinenlesbar.org/openka-lib-store";
import { normalizeSearchFilters } from "./filters.js";

export interface SearchFilters {
  parliament?: string[];
  party?: string[];
  year?: number[];
  period?: number[];
  /** Restrict to records in these review states. */
  reviewStatus?: string[];
  /**
   * Only records the extractor abstained on somewhere — verified or not. The
   * review queue (`reviewQueue`) is narrower: it leaves out `human_verified`.
   */
  onlyAbstained?: boolean;
  /** ISO dates bounding `dates.submitted` (falling back to `answered`). */
  from?: string;
  to?: string;
}

export interface SearchOptions extends SearchFilters {
  limit?: number;
  offset?: number;
  /** Include a text snippet around the first match (loads the record). */
  snippet?: boolean;
}

export interface SearchHit {
  entry: CatalogEntry;
  score: number;
  snippet?: string;
}

export interface SearchResult {
  total: number;
  hits: SearchHit[];
}

/**
 * True when a catalog row passes every structured filter. Expects filters in the
 * canonical form `normalizeSearchFilters` returns; `search()` and `searchLike()`
 * normalise before they call it.
 */
export function matchesFilters(entry: CatalogEntry, filters: SearchFilters): boolean {
  if (filters.parliament?.length && !filters.parliament.includes(entry.parliament)) return false;
  if (filters.period?.length && !filters.period.includes(entry.legislative_period)) return false;
  if (filters.year?.length && (entry.year === undefined || !filters.year.includes(entry.year))) return false;
  if (filters.reviewStatus?.length && !filters.reviewStatus.includes(entry.review_status)) return false;
  if (filters.onlyAbstained && entry.abstained === 0) return false;
  if (filters.party?.length) {
    const wanted = filters.party.map((party) => party.trim().toLowerCase());
    if (!entry.parties.some((party) => wanted.includes(party))) return false;
  }
  // Consistent with the discovery window: a record is dated by when it was asked.
  const date = entry.submitted ?? entry.answered;
  if (filters.from !== undefined && (date === undefined || date < filters.from)) return false;
  if (filters.to !== undefined && (date === undefined || date > filters.to)) return false;
  return true;
}

/**
 * Run a search. An empty query means "every record that passes the filters",
 * ordered by id, which is what `ka search --parliament berlin --year 2024` needs.
 * The filters are checked and normalised first (`normalizeSearchFilters`): a
 * filter that cannot match throws `OpenKaValidationError` instead of answering
 * "no matches".
 */
export function search(store: Store, query: string, searchOptions: SearchOptions = {}): SearchResult {
  const options: SearchOptions = { ...searchOptions, ...normalizeSearchFilters(searchOptions) };
  const parsed = parseQuery(query);
  const limit = options.limit ?? 20;
  const offset = options.offset ?? 0;

  let ranked: SearchHit[];
  if (parsed.required.length === 0) {
    // Nothing to rank by, so the catalog is the candidate set. A query that is
    // only exclusions (`-sanierung`) still has to remove what it excludes —
    // answering it with nothing would read as "no such records exist", which is
    // the opposite of what was asked.
    const excluded = excludedIds(store, parsed);
    ranked = store
      .catalog()
      .filter((entry) => !excluded.has(entry.id) && matchesFilters(entry, options))
      .map((entry) => ({ entry, score: 0 }));
  } else {
    ranked = rank(store, parsed, options);
  }

  const page = ranked.slice(offset, offset + limit);
  if (options.snippet) {
    for (const hit of page) {
      const snippet = makeSnippet(store, hit.entry.id, parsed.required);
      if (snippet !== undefined) hit.snippet = snippet;
    }
  }
  return { total: ranked.length, hits: page };
}

function rank(store: Store, parsed: ParsedQuery, filters: SearchFilters): SearchHit[] {
  const total = store.catalog().length;
  const scores = new Map<string, number>();
  const matchedTerms = new Map<string, number>();

  for (const term of parsed.required) {
    const postings = postingsFor(store, term);
    for (const [id, tf] of postings) {
      scores.set(id, (scores.get(id) ?? 0) + scoreTerm(tf, postings.length, total));
      matchedTerms.set(id, (matchedTerms.get(id) ?? 0) + 1);
    }
  }

  const excluded = excludedIds(store, parsed);

  const hits: SearchHit[] = [];
  for (const [id, score] of scores) {
    // AND semantics: every required term has to have matched this document.
    if (matchedTerms.get(id) !== parsed.required.length) continue;
    if (excluded.has(id)) continue;
    const entry = store.catalogEntry(id);
    if (entry === undefined || !matchesFilters(entry, filters)) continue;
    if (parsed.phrases.length > 0 && !confirmPhrases(store, id, parsed.phrases)) continue;
    hits.push({ entry, score });
  }

  // Ties break on id so that two runs over the same corpus print the same order.
  hits.sort((a, b) => b.score - a.score || (a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0));
  return hits;
}

/** Every document id carrying one of the query's `-term`s. */
function excludedIds(store: Store, parsed: ParsedQuery): Set<string> {
  const excluded = new Set<string>();
  for (const term of parsed.excluded) {
    for (const [id] of postingsFor(store, term)) excluded.add(id);
  }
  return excluded;
}

function postingsFor(store: Store, term: string): Posting[] {
  const shard = store.loadShard(shardOf(term));
  return shard[term] ?? [];
}

/**
 * The index stores term frequencies, not positions, so a phrase query is answered
 * in two steps: the index narrows the candidates to documents containing every
 * word, then the stored text confirms the words are adjacent.
 */
function confirmPhrases(store: Store, id: string, phrases: string[][]): boolean {
  const record = store.getRecord(id);
  if (record === undefined) return false;
  const haystack = [
    record.title,
    record.full_text ?? "",
    ...record.qa.map((pair) => `${pair.question ?? ""} ${pair.answer ?? ""}`),
  ].join("\n");
  return phrases.every((phrase) => containsPhrase(haystack, phrase));
}

const SNIPPET_RADIUS = 120;

/** A short window of text around the first occurrence of any query term. */
export function makeSnippet(store: Store, id: string, terms: string[]): string | undefined {
  const record = store.getRecord(id);
  if (record === undefined) return undefined;
  const text = record.qa.length
    ? record.qa.map((pair) => [pair.question, pair.answer].filter(Boolean).join(" ")).join("\n")
    : (record.full_text ?? record.title);
  // Search in the same normalised space the terms came from — they arrive with
  // umlauts already expanded (`brücken` -> `bruecken`), so matching them against
  // merely lowercased text never finds anything, and in a German corpus that is
  // the common case rather than the edge case. The offsets map the hit back onto
  // the untouched text so the snippet reads as the document does.
  const { normalized, offsets } = normalizeWithOffsets(text);
  let found = -1;
  for (const term of terms) {
    const hit = normalized.indexOf(term);
    if (hit >= 0 && (found < 0 || hit < found)) found = hit;
  }
  if (found < 0) return text.slice(0, SNIPPET_RADIUS * 2).replace(/\s+/g, " ").trim() || undefined;
  const at = offsets[found] ?? 0;
  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(text.length, at + SNIPPET_RADIUS);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return prefix + text.slice(start, end).replace(/\s+/g, " ").trim() + suffix;
}

type StoredRecord = NonNullable<ReturnType<Store["getRecord"]>>;

export interface SelectOptions extends SearchFilters {
  /** At most this many records; every match when omitted. */
  limit?: number;
}

export interface Selection {
  /** The selected records, in `search()` order. */
  records: StoredRecord[];
  /** Catalog rows that matched but whose record file is gone, by id. */
  missing: string[];
}

/**
 * The records a query and filters select, loaded from the store — what `ka export`
 * writes and `ka feed` picks its newest entries from.
 *
 * Every match unless `limit` says otherwise: `search()` pages (20 by default), and
 * a bulk selection that quietly stopped at a page was the wrong answer. Ordered as
 * `search()` orders — by id for an empty query, by relevance otherwise. A catalog
 * row whose record file is gone is named in `missing` rather than dropped without
 * a word; a reindex rebuilds the catalog from the records.
 */
export function selectRecords(store: Store, query = "", options: SelectOptions = {}): Selection {
  const { limit, ...filters } = options;
  const result = search(store, query, { ...filters, limit: limit ?? Number.MAX_SAFE_INTEGER });
  const records: StoredRecord[] = [];
  const missing: string[] = [];
  for (const hit of result.hits) {
    const record = store.getRecord(hit.entry.id);
    if (record === undefined) missing.push(hit.entry.id);
    else records.push(record);
  }
  return { records, missing };
}

/** How many rows `reviewQueue` returns when no limit is given. */
export const DEFAULT_REVIEW_LIMIT = 20;

export interface ReviewQueueOptions {
  /** Only this parliament's records. */
  parliament?: string;
  /** At most this many rows; `DEFAULT_REVIEW_LIMIT` when omitted. */
  limit?: number;
}

export interface ReviewQueue {
  /** Every record in the queue, before the limit. */
  total: number;
  entries: CatalogEntry[];
}

/**
 * The abstention queue `ka review` works: records the extractor abstained on
 * somewhere that no human has verified yet, most abstentions first, ties on the
 * id. Unlike the `onlyAbstained` search filter — which selects records with holes,
 * verified or not — a verified record has left the queue: a person checked its
 * holes, which is what the queue is for.
 */
export function reviewQueue(store: Store, options: ReviewQueueOptions = {}): ReviewQueue {
  const filters = normalizeSearchFilters({
    onlyAbstained: true,
    ...(options.parliament === undefined ? {} : { parliament: [options.parliament] }),
  });
  const queue = store
    .catalog()
    .filter((entry) => entry.review_status !== "human_verified" && matchesFilters(entry, filters))
    .sort((a, b) => b.abstained - a.abstained || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { total: queue.length, entries: queue.slice(0, options.limit ?? DEFAULT_REVIEW_LIMIT) };
}
