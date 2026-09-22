// discover → fetch → extract → normalize → store.
//
// The pipeline is idempotent and keyed on content: a document whose bytes are
// already in the blob store is not re-fetched, and a record whose inputs and
// extractor version are unchanged is not re-extracted. Re-running a sync over a
// window that has not moved therefore does nothing, costs one conditional request
// per feed, and leaves the corpus byte-identical.

import { OpenKaApiError, OpenKaError } from "../errors.js";
import type { FetchEngine } from "../http/engine.js";
import type { KaRecord } from "../models/schema.js";
import type { SourceState, Store } from "../store/store.js";
import { indexRecord } from "../store/indexer.js";
import { extract, type FetchedDocument, type SourceMetadata } from "../extract/tiers.js";
import { canonicalJson } from "../repro/canonical.js";
import { extractorVersion } from "../repro/version.js";
import { sha256 } from "../repro/hash.js";
import type { Perceiver } from "../perceive/perceiver.js";
import type { DocRef, Source } from "../../sources/base.js";

export interface SyncOptions {
  source: Source;
  store: Store;
  engine: FetchEngine;
  since?: string;
  until?: string;
  period?: number;
  limit?: number;
  apiKey?: string;
  perceiver?: Perceiver;
  /** Skip downloading documents; records get metadata only and abstain on `qa`. */
  metadataOnly?: boolean;
  /** Re-extract even when nothing changed. */
  force?: boolean;
  /** Called after each record, for progress output. */
  onProgress?: (event: ProgressEvent) => void;
  /** Injected clock — the only place the pipeline reads time (`retrieved_at`). */
  now?: () => Date;
}

export interface ProgressEvent {
  index: number;
  total: number;
  id: string;
  action: "stored" | "unchanged" | "failed";
  detail?: string;
}

export interface SyncReport {
  source: string;
  discovered: number;
  stored: number;
  unchanged: number;
  failed: number;
  /** Records stored with at least one abstained field. */
  needsReview: number;
  bytesFetched: number;
  warnings: string[];
  errors: string[];
  /** True when the upstream said nothing changed and no work was done. */
  upstreamUnchanged: boolean;
}

/** Run one source end to end. */
export async function sync(options: SyncOptions): Promise<SyncReport> {
  const { source, store, engine } = options;
  const now = options.now ?? (() => new Date());
  const state = store.getSourceState(source.key);
  const report: SyncReport = {
    source: source.key,
    discovered: 0,
    stored: 0,
    unchanged: 0,
    failed: 0,
    needsReview: 0,
    bytesFetched: 0,
    warnings: [],
    errors: [],
    upstreamUnchanged: false,
  };

  const startedAt = isoInstant(now());
  let discovered;
  try {
    const discoverOptions = {
      engine,
      store,
      state,
      ...(options.since !== undefined ? { since: options.since } : {}),
      ...(options.until !== undefined ? { until: options.until } : {}),
      ...(options.period !== undefined ? { period: options.period } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
      ...(options.force === true ? { force: true } : {}),
    };
    discovered = await source.discover(discoverOptions);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    report.errors.push(message);
    store.putSourceState({ ...state, last_sync: startedAt, last_error: message });
    return report;
  }

  report.warnings.push(...discovered.warnings);
  report.discovered = discovered.refs.length;
  report.upstreamUnchanged = discovered.unchanged === true;

  // Conditional-request state travels through the run and is persisted once at
  // the end, so an interrupted sync cannot leave a validator recorded for bytes
  // that were never stored.
  const httpCache = { ...(discovered.state ?? state).http_cache };

  let index = 0;
  for (const ref of discovered.refs) {
    index++;
    try {
      const outcome = await syncRef(ref, options, now, httpCache);
      if (outcome.action === "stored") {
        report.stored++;
        if (outcome.record !== undefined && outcome.record.extraction.abstained_fields.length > 0) {
          report.needsReview++;
        }
      } else {
        report.unchanged++;
      }
      report.bytesFetched += outcome.bytesFetched;
      options.onProgress?.({ index, total: discovered.refs.length, id: outcome.id, action: outcome.action });
    } catch (err) {
      report.failed++;
      const message = err instanceof Error ? err.message : String(err);
      report.errors.push(`${ref.reference}: ${message}`);
      options.onProgress?.({
        index,
        total: discovered.refs.length,
        id: ref.reference,
        action: "failed",
        detail: message,
      });
    }
  }

  const nextState = { ...(discovered.state ?? state), http_cache: httpCache, last_sync: startedAt };
  if (report.errors.length === 0) {
    nextState.last_success = startedAt;
    delete nextState.last_error;
  } else {
    nextState.last_error = report.errors[0] as string;
  }
  store.putSourceState(nextState);
  return report;
}

interface RefOutcome {
  id: string;
  action: "stored" | "unchanged";
  bytesFetched: number;
  record?: KaRecord;
}

async function syncRef(
  ref: DocRef,
  options: SyncOptions,
  now: () => Date,
  httpCache: SourceState["http_cache"],
): Promise<RefOutcome> {
  const { source, store, engine } = options;
  const parliament = ref.parliament ?? source.parliament;
  const documents: FetchedDocument[] = [];
  let bytesFetched = 0;

  if (!options.metadataOnly) {
    for (const wanted of ref.documents) {
      const fetched = await fetchDocument(engine, store, wanted.url, now, httpCache);
      if (fetched === undefined) continue;
      bytesFetched += fetched.fromCache ? 0 : fetched.bytes.length;
      documents.push({
        role: wanted.role,
        url: wanted.url,
        bytes: fetched.bytes,
        urlStable: wanted.urlStable,
        retrievedAt: fetched.retrievedAt,
      });
    }
  }

  const metadata: SourceMetadata = {
    reference: ref.reference,
    legislative_period: ref.legislative_period,
    title: ref.title,
    askers: ref.askers,
    answered_by: ref.answered_by,
    dates: ref.dates,
  };

  const request = {
    parliament,
    documentType: ref.documentType,
    tier: source.tier,
    metadata,
    documents,
    ...(source.ruleSets !== undefined ? { ruleSets: source.ruleSets } : {}),
    ...(options.perceiver !== undefined ? { perceiver: options.perceiver } : {}),
  };

  // Idempotence: the inputs are the document bytes and the extractor version, so a
  // record whose stored provenance already matches both needs no work.
  const existing = store.getRecord(recordIdFor(request));
  if (!options.force && existing !== undefined && isUpToDate(existing, documents, metadata)) {
    return { id: existing.id, action: "unchanged", bytesFetched };
  }

  const { record } = await extract(request);
  store.putRecord(record);
  indexRecord(store, record);
  return { id: record.id, action: "stored", bytesFetched, record };
}

function recordIdFor(request: { parliament: string; metadata: SourceMetadata }): string {
  const tail = request.metadata.reference.includes("/")
    ? request.metadata.reference.slice(request.metadata.reference.indexOf("/") + 1)
    : request.metadata.reference;
  const slug = tail.replace(/\s+/g, "").replace(/[^0-9A-Za-z-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").toLowerCase();
  return `${request.parliament}-${request.metadata.legislative_period}-${slug}`;
}

/**
 * Is the stored record still the right answer for these inputs? Compares the
 * extractor version, the hash of the bytes that were parsed, and the metadata the
 * source supplied — so a correction upstream does trigger a rewrite, and a re-run
 * over identical inputs does not.
 *
 * Every field the source states verbatim is compared, not just the title and the
 * dates: when a Landtag corrects a misattributed MP or names the answering
 * ministry, the sync used to report "unchanged" and keep the wrong value
 * indefinitely.
 *
 * Two fields need care, because extraction may fill in what the source left out.
 * `answered_by` is only compared where the source actually stated something —
 * `findMinistry` derives a ministry from the document text otherwise, and
 * comparing against that would rewrite every record on every run. The same holds
 * for a title or date a validator rejected and cleared.
 */
function isUpToDate(existing: KaRecord, documents: FetchedDocument[], metadata: SourceMetadata): boolean {
  if (existing.extraction.extractor_version !== extractorVersion()) return false;
  const stored = new Set(existing.source_documents.map((document) => document.sha256).filter(Boolean));
  for (const document of documents) {
    if (!stored.has(sha256(document.bytes))) return false;
  }
  if (documents.length !== existing.source_documents.length) return false;

  if (existing.reference !== metadata.reference) return false;
  if (existing.legislative_period !== metadata.legislative_period) return false;
  if (canonicalJson(existing.askers) !== canonicalJson(metadata.askers)) return false;

  // Stated-only fields: a value the source supplies must match; one it omits is
  // left to whatever extraction derived.
  for (const key of ["ministry", "signatory"] as const) {
    const claimed = metadata.answered_by[key];
    if (claimed !== undefined && existing.answered_by[key] !== claimed) return false;
  }
  if (metadata.title !== "" && existing.title !== "" && existing.title !== metadata.title) return false;
  for (const key of ["submitted", "answered"] as const) {
    const claimed = metadata.dates[key];
    if (claimed !== undefined && existing.dates[key] !== undefined && existing.dates[key] !== claimed) return false;
    if (claimed === undefined && existing.dates[key] !== undefined) return false;
  }
  return true;
}

interface FetchedBytes {
  bytes: Buffer;
  retrievedAt: string;
  fromCache: boolean;
}

/**
 * Fetch a document, or take it from the blob store when the upstream says it has
 * not changed. Returns `undefined` for a document the upstream no longer serves;
 * that is a gap in the record, not a reason to abort the whole sync.
 *
 * Two things keep this polite. The conditional request means an unchanged PDF costs
 * one 304 and no bytes. And because the blob store is content-addressed, a document
 * that is byte-identical to one already held is stored once however many records
 * point at it — which matters for the Länder that publish one PDF per Anfrage and
 * re-serve it under several URLs.
 */
async function fetchDocument(
  engine: FetchEngine,
  store: Store,
  url: string,
  now: () => Date,
  httpCache: SourceState["http_cache"],
): Promise<FetchedBytes | undefined> {
  const cached = httpCache[url];
  const validators: { etag?: string; last_modified?: string } = {};
  if (cached?.etag !== undefined) validators.etag = cached.etag;
  if (cached?.last_modified !== undefined) validators.last_modified = cached.last_modified;
  const canRevalidate = cached?.sha256 !== undefined && store.hasBlob(cached.sha256);

  let response;
  try {
    response = await engine.get(url, canRevalidate ? { validators } : {});
  } catch (err) {
    if (err instanceof OpenKaApiError && err.status === 404) return undefined;
    throw err;
  }

  if (response.notModified) {
    return {
      bytes: store.getBlob(cached?.sha256 as string),
      retrievedAt: isoInstant(now()),
      fromCache: true,
    };
  }

  if (response.body.length === 0) throw new OpenKaError(`Empty document at ${url}`);
  const digest = store.putBlob(response.body);
  const entry: { etag?: string; last_modified?: string; sha256?: string } = { sha256: digest };
  if (response.etag !== undefined) entry.etag = response.etag;
  if (response.lastModified !== undefined) entry.last_modified = response.lastModified;
  httpCache[url] = entry;
  return { bytes: store.getBlob(digest), retrievedAt: isoInstant(now()), fromCache: false };
}

/** ISO-8601 UTC to the second — the precision `retrieved_at` is specified at. */
export function isoInstant(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}
