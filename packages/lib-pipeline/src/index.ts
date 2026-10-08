// discover → fetch → extract → normalize → store.
//
// The pipeline is idempotent and keyed on content: a document whose bytes are
// already in the blob store is not re-fetched, and a record whose inputs and
// extractor version are unchanged is not re-extracted. Re-running a sync over a
// window that has not moved therefore does nothing, costs one conditional request
// per feed, and leaves the corpus byte-identical.

import { NetworkError, OpenKaApiError, OpenKaError, StoreError, UsageError } from "@maschinenlesbar.org/openka-lib-errors";
import type { FetchEngine, RetryReasons } from "@maschinenlesbar.org/openka-lib-http";
import { currentReference, makeRecordId, parseReference, periodNumber, referenceSlug, type KaRecord } from "@maschinenlesbar.org/openka-lib-models";
import { indexRecord, unindexRecord, withCorpusLock, type SourceState, type SpaceGuard, type Store } from "@maschinenlesbar.org/openka-lib-store";
import { extract, type FetchedDocument, type SourceMetadata } from "@maschinenlesbar.org/openka-lib-extract";
import { canonicalJson, extractorVersion, sha256 } from "@maschinenlesbar.org/openka-lib-repro";
import type { Perceiver } from "@maschinenlesbar.org/openka-lib-perceive";
import { RobotsPolicy, type DocRef, type Source } from "@maschinenlesbar.org/openka-lib-source";
import { isSelective, normalizeSyncWindow, type SyncWindow } from "./window.js";
import { noteOutcome, sameReference, selectRefs } from "./select.js";
import { corpusEstimate, documentsToFetch } from "./plan.js";

/** One source over one window (`SyncWindow`: what is discovered, and which of it is handled). */
export interface SyncOptions extends SyncWindow {
  source: Source;
  store: Store;
  engine: FetchEngine;
  /**
   * The run's robots.txt policy, shared by every source of one `syncSources` run so
   * a host's file is read once for all of them. Built for this source when absent;
   * one that is given must have been built with the same `ignoreRobots`.
   */
  robots?: RobotsPolicy;
  /** The run's documents, shared the same way: a URL one source fetched is not fetched again. */
  documents?: DocumentMemo;
  apiKey?: string;
  perceiver?: Perceiver;
  /**
   * Download no documents. A new record gets metadata only and abstains on `qa`; a
   * stored one is re-extracted from the documents it already archived, so a
   * metadata correction lands and nothing it held is lost.
   */
  metadataOnly?: boolean;
  /** Re-extract even when nothing changed. */
  force?: boolean;
  /**
   * Fetch from a server whose robots.txt disallows it. Two Länder publish their
   * Drucksachen openly and disallow every client; this is the operator's decision
   * to make. The pipeline checks every document URL against its host's robots.txt
   * before fetching it, whichever source produced the URL, and the override is
   * never silent: the report warns once per host.
   */
  ignoreRobots?: boolean;
  /**
   * Called once discovery is done, with the number of Anfragen the run will
   * handle — the total a progress display counts towards. Not called when
   * discovery fails.
   */
  onDiscovered?: (count: number) => void;
  /** Called after each record, for progress output. */
  onProgress?: (event: ProgressEvent) => void;
  /** Injected clock — the only place the pipeline reads time (`retrieved_at`). */
  now?: () => Date;
  /**
   * Stop early: checked before each ref, so the ref in hand is finished, the
   * catalog is saved and the report says `interrupted`. `ka sync` aborts it on the
   * first Ctrl-C or SIGTERM.
   */
  signal?: AbortSignal;
  /**
   * The disk-space guard (`spaceGuard` from lib-store). Given, a run whose documents
   * to fetch would not fit — estimated from what the source already archived — is
   * refused with `StoreError` after discovery and before the first download, and a
   * run stops between two refs, like an aborted one, once a volume drops below the
   * floor (`SyncReport.lowSpace`).
   */
  space?: SpaceGuard;
}

/**
 * How long one batch of a sync runs before its index postings and catalog rows are
 * written (`batchCatalog`). A run killed outright (SIGKILL, a power cut) loses the rows
 * and postings of at most one batch — the records are on disk, and the next sync over
 * the window, or `ka reindex`, catalogues them again. One batch for the whole run lost
 * every row of a long sync to a Ctrl-C.
 *
 * It was 25 refs. Each batch rewrites every shard its records touch, which for long
 * papers is all 256 — the whole index, 202 MB in a corpus of 7,500 — so at a fast source
 * it rewrote the index every few seconds (issue #30). By time, the cost stays a share of
 * the run.
 */
export const CHECKPOINT_MS = 120_000;

/** The most refs one batch takes, whatever the time: what it keeps in memory until it is written. */
export const CHECKPOINT_REFS = 250;

export interface ProgressEvent {
  index: number;
  total: number;
  id: string;
  action: "stored" | "unchanged" | "failed";
  detail?: string;
  /** Where the run's time has gone so far — for a progress line that says why it is slow. */
  timing?: SyncTiming;
  /** How long this Anfrage took, fetching included. */
  ms?: number;
  /** Bytes downloaded for it (0 when its documents were archived and unchanged). */
  bytes?: number;
  /** For a stored record: the fields it abstains on. */
  abstained?: string[];
  /** Its documents that were not fetched, and why — the URL behind a hole (issue #10). */
  gaps?: DocumentGap[];
}

/** A document of an Anfrage that was not fetched: its URL, the kind of gap and the reason in words. */
export interface DocumentGap {
  url: string;
  gap: FetchGap["gap"];
  reason: string;
}

/**
 * Where a run's time went (issue #14): waiting on the upstream, waiting to be polite,
 * or extracting and storing. A slow sync could not tell these apart without `ps`,
 * `iostat` and `nettop`. Upstream numbers are the engine's (`EngineMetrics`) since the
 * run began; the rest are the pipeline's, on its clock (`SyncOptions.now`).
 */
export interface SyncTiming {
  /** Since the run began, discovery included. */
  elapsedMs: number;
  /** Requests sent (attempts and redirect hops), and how many were retries. */
  requests: number;
  retries: number;
  /** 429/503 answers: the upstream asking to slow down. */
  throttled: number;
  /** The retries by reason: a 429/503, a timeout, a failed connection, anything else (issue #31). */
  retryReasons: RetryReasons;
  /** Requests sent again at once on a new connection, the kept-alive one having been closed by the server; not retries. */
  reconnects: number;
  /** Time inside one request, on average and at the 95th percentile; absent before the first. */
  upstreamMsAvg?: number;
  upstreamMsP95?: number;
  /** Time spent waiting before requests: pacing (`--min-host-interval`, a source's floor) and retry backoff. */
  waitMs: number;
  /** Time spent extracting records, and writing the records. */
  extractMs: number;
  storeMs: number;
  /**
   * Time spent writing the index postings and catalog rows, once per batch
   * (`CHECKPOINT_MS`). It was inside `storeMs`, and was most of it (issue #30).
   */
  indexMs: number;
}

export interface SyncReport {
  source: string;
  discovered: number;
  /** Discovered, and left out by the job's selection (`--ref`, `--retry-failed`, `--only-new`) — no request was made for them. */
  skipped: number;
  stored: number;
  unchanged: number;
  failed: number;
  /** Records stored with at least one abstained field. */
  needsReview: number;
  bytesFetched: number;
  warnings: string[];
  errors: string[];
  /**
   * Why the source did not look at all (`DiscoverResult.blocked`), when it did not:
   * its documents are disallowed and --ignore-robots was not given. Such a run is not
   * an empty one, and is not recorded as a sync in the source's state.
   */
  blocked?: string;
  /** True when the upstream said nothing changed and no work was done. */
  upstreamUnchanged: boolean;
  /**
   * Unchanged records that were on disk but missing from the catalog — what an
   * interrupted run left behind — and were indexed again. Counted in `unchanged`.
   */
  recatalogued: number;
  /** True when `signal` stopped the run before every ref was handled. */
  interrupted: boolean;
  /** Where the run's time went (`SyncTiming`). */
  timing: SyncTiming;
  /**
   * Why the run stopped before every ref was handled because a volume ran low on
   * space (`SyncOptions.space`). Like an interrupted run, it keeps what it stored and
   * counts neither as a success nor as a degraded source.
   */
  lowSpace?: string;
}

/**
 * Run one source end to end. The window and budget are checked first
 * (`normalizeSyncWindow`): a bad one rejects with `OpenKaValidationError` before
 * any request, and is not recorded as a source error.
 *
 * A source's politeness floor (`Source.minHostIntervalMs`) is applied to the
 * engine before discovery, with `engine.raiseMinHostInterval`: it raises the
 * engine's interval and never lowers it, and it stays raised on that engine.
 *
 * The run holds the corpus lock (`Store.lock`): while another sync, a reindex or
 * a review mark writes to the same corpus, it rejects with `CorpusLockedError`
 * before any request.
 */
export async function sync(rawOptions: SyncOptions): Promise<SyncReport> {
  const options = normalizeSyncWindow(rawOptions);
  // One writer at a time: two syncs on one corpus lost postings and catalog rows
  // while both reported success. The second one is refused before any request.
  return withCorpusLock(options.store, `sync --source ${options.source.key}`, () => syncLocked(options));
}

async function syncLocked(options: SyncOptions): Promise<SyncReport> {
  const clock = options.now ?? (() => new Date());
  const watch: Stopwatch = { extractMs: 0, storeMs: 0, indexMs: 0 };
  const timing = timingSince(options.engine, clock, watch);
  const report = await syncTimed(options, watch, timing);
  report.timing = timing();
  return report;
}

/** What the pipeline times itself: extraction and writing. */
interface Stopwatch {
  extractMs: number;
  storeMs: number;
  indexMs: number;
}

/** A function that says where the time has gone since now, on `engine` and `watch`. */
function timingSince(engine: FetchEngine, clock: () => Date, watch: Stopwatch): () => SyncTiming {
  const startedAt = clock().getTime();
  const base = { ...engine.metrics, retryReasons: { ...engine.metrics.retryReasons }, durations: engine.metrics.durations.length };
  return () => {
    const m = engine.metrics;
    const durations = m.durations.slice(base.durations);
    const timing: SyncTiming = {
      elapsedMs: Math.max(0, clock().getTime() - startedAt),
      requests: m.requests - base.requests,
      retries: m.retries - base.retries,
      throttled: m.throttled - base.throttled,
      retryReasons: {
        throttled: m.retryReasons.throttled - base.retryReasons.throttled,
        timeout: m.retryReasons.timeout - base.retryReasons.timeout,
        connection: m.retryReasons.connection - base.retryReasons.connection,
        other: m.retryReasons.other - base.retryReasons.other,
      },
      reconnects: m.reconnects - base.reconnects,
      waitMs: m.waitMs - base.waitMs,
      extractMs: watch.extractMs,
      storeMs: watch.storeMs,
      indexMs: watch.indexMs,
    };
    if (durations.length > 0) {
      timing.upstreamMsAvg = Math.round((m.upstreamMs - base.upstreamMs) / durations.length);
      const sorted = [...durations].sort((a, b) => a - b);
      timing.upstreamMsP95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] as number;
    }
    return timing;
  };
}

async function syncTimed(options: SyncOptions, watch: Stopwatch, timing: () => SyncTiming): Promise<SyncReport> {
  const { source, store, engine } = options;
  // A blob directory on an unplugged drive is the corpus's problem, named before
  // any request — not a failed fetch per Anfrage. Also with --metadata-only, which
  // re-extracts a stored record from its archived documents.
  store.assertBlobStore?.();
  if (source.minHostIntervalMs !== undefined) engine.raiseMinHostInterval(source.minHostIntervalMs);
  const now = options.now ?? (() => new Date());
  const state = store.getSourceState(source.key);
  const report: SyncReport = {
    source: source.key,
    discovered: 0,
    skipped: 0,
    stored: 0,
    unchanged: 0,
    failed: 0,
    needsReview: 0,
    bytesFetched: 0,
    warnings: [],
    errors: [],
    upstreamUnchanged: false,
    recatalogued: 0,
    interrupted: false,
    timing: timing(),
  };

  const startedAt = isoInstant(now());
  const selective = isSelective(options);
  // One reading of each host's robots.txt for the whole run: the connector's gate
  // (if it has one) and every document check below ask the same policy.
  const robots = options.robots ?? new RobotsPolicy(engine, options.ignoreRobots === true);
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
      // A selection needs the refs: a feed unchanged since the last sync answers 304
      // and lists none, and the one Anfrage asked for would not be found.
      ...(options.force === true || selective ? { force: true } : {}),
      ...(options.ignoreRobots === true ? { ignoreRobots: true } : {}),
      robots,
    };
    discovered = await source.discover(discoverOptions);
  } catch (err) {
    // A usage error is the source saying the *request* cannot be honoured as
    // typed. That is the operator's to fix, not a degraded source to record.
    if (err instanceof UsageError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    report.errors.push(message);
    store.putSourceState({ ...state, last_sync: startedAt, last_error: message });
    return report;
  }

  report.warnings.push(...discovered.warnings);
  report.discovered = discovered.refs.length;
  if (discovered.blocked !== undefined) {
    // Nothing was looked at: no state is written, so `ka sources list` does not show
    // a sync that never happened.
    report.blocked = discovered.blocked;
    return report;
  }
  if (options.since !== undefined || options.until !== undefined) {
    const placed = discovered.refs.filter((ref) => ref.dates.submitted === undefined && ref.dates.answered !== undefined).length;
    if (placed > 0) {
      report.warnings.push(
        `${placed} of ${discovered.refs.length} Anfragen carry no question date in the source (combined papers), so the ` +
          "window was applied to their answer date: one asked inside it and answered after --until is not included. " +
          "The corpus's own --from/--to and --year use the question's date only.",
      );
    }
  }
  report.upstreamUnchanged = discovered.unchanged === true;
  const selection = selectRefs(discovered.refs, options, { source, store, state });
  report.skipped = selection.skipped;
  report.warnings.push(...selection.warnings);

  // Before the first download: will it fit? Only an estimate this source's own
  // archive supports is used — a sync makes no HEAD requests to guess — so a
  // source's first sync is guarded by the floor alone (and `--dry-run` samples).
  if (options.space !== undefined && options.metadataOnly !== true) {
    const cache = (discovered.state ?? state).http_cache;
    const toFetch = documentsToFetch(selection.refs, cache, store);
    const estimate = toFetch.length === 0 ? undefined : corpusEstimate(store, cache, toFetch.length);
    const problem = estimate === undefined ? undefined : options.space.fitProblem(estimate.total_bytes);
    if (problem !== undefined) {
      throw new StoreError(`${source.key}: ${toFetch.length} document(s) to fetch, and ${problem}. Nothing was downloaded.`);
    }
  }
  options.onDiscovered?.(selection.refs.length);

  // Conditional-request state travels through the run and is persisted once at
  // the end, so an interrupted sync cannot leave a validator recorded for bytes
  // that were never stored.
  const httpCache = { ...(discovered.state ?? state).http_cache };
  const run: RunContext = {
    gaps: [],
    watch,
    robots,
    warnings: report.warnings,
    notedOrigins: new Set(),
    fetched: options.documents ?? new DocumentMemo(),
  };

  // One write of the catalog and of each touched index shard per batch rather than
  // per record (`CHECKPOINT_MS`, `CHECKPOINT_REFS`): both grow with the corpus, and
  // rewriting them per record made a sync quadratic in corpus size. Each batch also
  // writes when the loop throws.
  const refs = selection.refs;
  let failed = state.failed ?? [];
  let index = 0;
  const handle = async (ref: DocRef): Promise<void> => {
    index++;
    run.gaps = [];
    const began = now().getTime();
    const details = (): Pick<ProgressEvent, "ms" | "gaps" | "timing"> => ({
      ms: Math.max(0, now().getTime() - began),
      ...(run.gaps.length === 0 ? {} : { gaps: run.gaps }),
      timing: timing(),
    });
    try {
      const outcome = await syncRef(ref, options, now, httpCache, run);
      if (outcome.recatalogued === true) report.recatalogued++;
      if (outcome.action === "stored") {
        report.stored++;
        if (outcome.record !== undefined && outcome.record.extraction.abstained_fields.length > 0) {
          report.needsReview++;
        }
      } else {
        report.unchanged++;
      }
      report.bytesFetched += outcome.bytesFetched;
      failed = noteOutcome(failed, ref, undefined, startedAt);
      options.onProgress?.({
        index,
        total: refs.length,
        id: outcome.id,
        action: outcome.action,
        bytes: outcome.bytesFetched,
        ...(outcome.record === undefined ? {} : { abstained: outcome.record.extraction.abstained_fields }),
        ...details(),
      });
    } catch (err) {
      report.failed++;
      const message = err instanceof Error ? err.message : String(err);
      report.errors.push(`${ref.reference}: ${message}`);
      failed = noteOutcome(failed, ref, message, startedAt);
      options.onProgress?.({ index, total: refs.length, id: ref.reference, action: "failed", detail: message, ...details() });
    }
  };
  let next = 0;
  while (next < refs.length && !report.interrupted && report.lowSpace === undefined) {
    const batchStart = now().getTime();
    let handling = 0;
    await store.batchCatalog(async () => {
      for (let taken = 0; next < refs.length && taken < CHECKPOINT_REFS; taken++) {
        if (options.signal?.aborted === true) {
          report.interrupted = true;
          return;
        }
        // One statfs per volume and ref: cheap beside a download, and the only way
        // to stop with room left for the catalog rather than at the first ENOSPC.
        const low = options.space?.lowProblem();
        if (low !== undefined) {
          report.lowSpace = low;
          return;
        }
        const began = now().getTime();
        await handle(refs[next++] as DocRef);
        handling += Math.max(0, now().getTime() - began);
        if (now().getTime() - batchStart >= CHECKPOINT_MS) return;
      }
    });
    // What the batch took beyond its refs is the writing of the index and catalog.
    watch.indexMs += Math.max(0, now().getTime() - batchStart - handling);
  }

  // A run stopped early still records the validators of what it stored: every one
  // of them belongs to bytes that are in the blob store. It does not count as a
  // success, since the window was not covered.
  const nextState: SourceState = { ...(discovered.state ?? state), http_cache: httpCache, last_sync: startedAt };
  if (failed.length > 0) nextState.failed = failed;
  else delete nextState.failed;
  const stoppedEarly = report.interrupted || report.lowSpace !== undefined;
  if (stoppedEarly || selective) {
    // The source's own validators — a feed's ETag — say "everything this window holds
    // was handled", which a run that stopped early, or handled a selection of it,
    // cannot say: kept, the next run of the same window got a 304 and did nothing
    // (issue #11). They go back to what they were; the documents' validators stay,
    // since their bytes are archived.
    for (const key of Object.keys(discovered.state?.http_cache ?? {})) {
      if (JSON.stringify(discovered.state?.http_cache[key]) === JSON.stringify(state.http_cache[key])) continue;
      const before = state.http_cache[key];
      if (before === undefined) delete httpCache[key];
      else httpCache[key] = before;
    }
  }
  if (stoppedEarly) {
    // Neither a success nor a degraded source: last_success and last_error stay.
  } else if (report.errors.length === 0) {
    nextState.last_success = startedAt;
    delete nextState.last_error;
  } else {
    nextState.last_error = report.errors[0] as string;
  }
  store.putSourceState(nextState);
  return report;
}

/** What every document fetch of one run shares: the robots.txt verdicts and where to say so. */
interface RunContext {
  /** The gaps of the Anfrage in hand, emptied before each one (`ProgressEvent.gaps`). */
  gaps: DocumentGap[];
  /** Where extraction and writing time is added up. */
  watch: Stopwatch;
  robots: RobotsPolicy;
  warnings: string[];
  /** Hosts already warned about, so a hundred documents on one host warn once. */
  notedOrigins: Set<string>;
  /**
   * What each document URL gave this run. A Land that files question and answer
   * under one Drucksache links the same URL for both roles (Sachsen's viewer links,
   * and the Parlamentsspiegel rows that point at them); it was downloaded once per
   * role — twice, 4 s apart, from a server that asked not to be crawled.
   */
  fetched: DocumentMemo;
}

/**
 * What each document URL gave during one run — bytes or a gap — shared by the
 * sources of a `syncSources` run. Two sources that reach the same documents (a Land's
 * connector and `parlamentsspiegel`) downloaded each one again, only to find it
 * unchanged. Promises are kept, so two lanes asking for one URL at once share one
 * download.
 */
export class DocumentMemo {
  private readonly entries = new Map<string, Promise<FetchedBytes | FetchGap>>();

  /** @internal */
  remember(url: string, fetch: () => Promise<FetchedBytes | FetchGap>): Promise<{ result: FetchedBytes | FetchGap; again: boolean }> {
    const known = this.entries.get(url);
    if (known !== undefined) return known.then((result) => ({ result, again: true }));
    const pending = fetch();
    this.entries.set(url, pending);
    // A failed fetch is not remembered: the next source may try it.
    pending.catch(() => this.entries.delete(url));
    return pending.then((result) => ({ result, again: false }));
  }
}

interface RefOutcome {
  id: string;
  action: "stored" | "unchanged";
  bytesFetched: number;
  record?: KaRecord;
  /** An unchanged record that had no catalog row and was indexed again. */
  recatalogued?: boolean;
}

async function syncRef(
  ref: DocRef,
  options: SyncOptions,
  now: () => Date,
  httpCache: SourceState["http_cache"],
  run: RunContext,
): Promise<RefOutcome> {
  const { source, store, engine } = options;
  // A source pinned to one Land names it; one covering several leaves it to the
  // ref. If neither says, there is no honest place to file the record — guessing
  // would put a Land's Anfrage under another Land's name, so the ref fails and the
  // report says which one.
  const parliament = ref.parliament ?? source.parliament;
  if (parliament === undefined) {
    throw new OpenKaError(
      `${ref.reference}: neither the ref nor the ${source.key} adapter names a parliament`,
    );
  }
  const metadata: SourceMetadata = {
    reference: ref.reference,
    legislative_period: ref.legislative_period,
    title: ref.title,
    askers: ref.askers,
    answered_by: ref.answered_by,
    dates: ref.dates,
  };
  // A record id is the parliament, the period and a slug of the reference, and the
  // slug folds every punctuation mark to "-" — so "19/9.1" and "19/9-1" are one id,
  // and "19/../.." is none at all. The second of two such refs used to replace the
  // first silently, both counted as stored.
  if (referenceSlug(ref.reference) === "") {
    throw new OpenKaError(`reference "${ref.reference}" yields no record id`);
  }
  const id = recordIdFor({ parliament, metadata });
  const existing = store.getRecord(id);
  if (existing !== undefined && !sameReference(existing.reference, ref.reference)) {
    throw new OpenKaError(
      `reference "${ref.reference}" maps to record id ${id}, which already holds "${existing.reference}"; ` +
        "the stored record was not overwritten",
    );
  }
  // A record an earlier build filed here under a reference this build reads otherwise
  // (`currentReference`): Sachsen-Anhalt's KA 8/1487 stored as "08/1487", where
  // Drucksache 8/1487 belongs. Overwriting it lost the question; moving it is `ka
  // reextract`'s, which also tells a stale copy from the only one (issue #25).
  const filedAs = existing === undefined ? undefined : currentReference({ parliament: existing.parliament, reference: existing.reference, ...existing.dates });
  if (filedAs !== undefined) {
    throw new OpenKaError(
      `record id ${id} holds ${filedAs}, filed by an earlier build under "${existing?.reference}"; ` +
        "`ka reextract --all` moves it to its own id — the stored record was not overwritten",
    );
  }

  // An answer that continues a question the corpus holds under its own number
  // (`DocRef.replaces`): the question's date is the answer's question date, which the
  // answer's row does not print (issue #22), and the question-only record goes once
  // the answer is stored. Once it is gone the answer's own stored date carries it on.
  const replaced = (ref.replaces ?? []).flatMap((reference) => {
    const parsed = parseReference(reference);
    const record = store.getRecord(makeRecordId(parliament, parsed === undefined ? ref.legislative_period : periodNumber(parsed), reference));
    return record === undefined || record.id === id ? [] : [record];
  });
  if (ref.dates.submitted === undefined) {
    const carried = replaced.find((record) => record.dates.submitted !== undefined)?.dates.submitted ?? (ref.replaces === undefined ? undefined : existing?.dates.submitted);
    if (carried !== undefined) metadata.dates = { ...ref.dates, submitted: carried };
  }
  // A copy of this very ref filed under a former reference (`DocRef.formerly`), proven
  // by holding the same documents; nothing else of that id is touched.
  const urls = new Set(ref.documents.map((document) => document.url));
  const misfiled = (ref.formerly ?? []).flatMap((reference) => {
    const record = store.getRecord(makeRecordId(parliament, ref.legislative_period, reference));
    const same =
      record !== undefined && record.id !== id && record.source_documents.length > 0 && record.source_documents.every((document) => urls.has(document.url));
    return same ? [record as KaRecord] : [];
  });
  const retire = (): void => {
    for (const record of [...replaced, ...misfiled]) {
      unindexRecord(store, record.id, record);
      store.deleteRecord(record.id);
    }
    for (const record of replaced) run.warnings.push(`${ref.reference}: continues ${record.reference}; took its question date and removed its question-only record`);
    for (const record of misfiled) run.warnings.push(`${ref.reference}: removed the copy misfiled as ${record.reference} (${record.id})`);
  };

  const documents: FetchedDocument[] = [];
  let bytesFetched = 0;

  if (options.metadataOnly) {
    // Nothing is downloaded — but a stored record keeps the documents it was built
    // from: their archived bytes are read again. Re-extracting from no documents at
    // all replaced every complete record a metadata-only run touched with an empty
    // one, Q/A pairs and archive links gone, and counted it as stored.
    for (const wanted of ref.documents) {
      const archived = existing?.source_documents.find((document) => document.url === wanted.url && document.sha256 !== undefined);
      if (archived?.sha256 === undefined) continue;
      if (!store.hasBlob(archived.sha256)) {
        throw new OpenKaError(
          `${wanted.url}: the archived copy the stored record was built from is missing, and --metadata-only ` +
            "fetches nothing; the stored record was left as it was",
        );
      }
      documents.push({
        role: wanted.role,
        url: wanted.url,
        bytes: store.getBlob(archived.sha256),
        urlStable: wanted.urlStable,
        ...(archived.retrieved_at === undefined ? {} : { retrievedAt: archived.retrieved_at }),
      });
    }
  } else {
    for (const wanted of ref.documents) {
      const fetched = await fetchDocument(engine, store, wanted.url, now, httpCache, run, wanted.role !== "metadata");
      if ("gap" in fetched) {
        run.gaps.push({ url: wanted.url, gap: fetched.gap, reason: gapText(fetched) });
        // The upstream no longer hands this document out — a 404, or a robots.txt
        // that now disallows it. A record that already holds it must not be
        // re-extracted from nothing: that overwrote complete records with empty
        // ones and reported them as stored, and `ka verify` then "reproduced" the
        // empty one. The archived bytes are what the record was built from, so
        // they are read again, dated when they were actually retrieved.
        const archived = existing?.source_documents.find((document) => document.url === wanted.url);
        if (archived?.sha256 === undefined) {
          if (fetched.gap !== "robots") run.warnings.push(`${ref.reference}: ${wanted.url} ${gapText(fetched)}`);
          continue;
        }
        if (!store.hasBlob(archived.sha256)) {
          throw new OpenKaError(
            `${wanted.url} ${gapText(fetched)}, and the archived copy the stored record was built from is missing; ` +
              "the stored record was left as it was",
          );
        }
        run.warnings.push(
          `${ref.reference}: ${wanted.url} ${gapText(fetched)}; ` +
            `kept the archived copy${archived.retrieved_at === undefined ? "" : ` retrieved ${archived.retrieved_at}`}`,
        );
        documents.push({
          role: wanted.role,
          url: wanted.url,
          bytes: store.getBlob(archived.sha256),
          urlStable: wanted.urlStable,
          ...(archived.retrieved_at === undefined ? {} : { retrievedAt: archived.retrieved_at }),
        });
        continue;
      }
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
  if (!options.force && existing !== undefined && isUpToDate(existing, documents, metadata)) {
    // Unchanged, but not necessarily findable: a run interrupted before its catalog
    // was saved left the record on disk with no catalog row, and every later run
    // returned here — "unchanged", invisible to search, stats and export for good.
    if (store.catalogEntry(existing.id) === undefined) {
      indexRecord(store, existing);
      retire();
      return { id: existing.id, action: "unchanged", bytesFetched, recatalogued: true };
    }
    retire();
    return { id: existing.id, action: "unchanged", bytesFetched };
  }

  const extractStart = now().getTime();
  const { record } = await extract(request);
  run.watch.extractMs += Math.max(0, now().getTime() - extractStart);
  // A source that can tell whether the document is the paper the ref names says so
  // here; a mismatch stores nothing. A row and its PDF are joined only by a URL, and a
  // record that paired one paper's metadata with another's text verified fine.
  const mismatch = source.checkRecord?.(ref, record);
  if (mismatch !== undefined) throw new OpenKaError(`${mismatch}; the record was not stored`);
  // A person's `human_verified` mark is the one thing re-extraction cannot
  // reproduce. It survives a re-extraction that changed nothing a person checked
  // (`--force` over the same bytes and extractor); when the content did change,
  // the mark goes and the report says so, since what was checked is gone.
  if (existing?.extraction.review_status === "human_verified") {
    if (sameContent(existing, record)) record.extraction.review_status = "human_verified";
    else {
      run.warnings.push(
        `${ref.reference}: was marked human_verified; the re-extracted record differs, so the mark was dropped — ` +
          "check it again (`ka review --mark-verified`)",
      );
    }
  }
  const storeStart = now().getTime();
  store.putRecord(record);
  // The postings in the index are the stored record's, which putRecord just replaced.
  indexRecord(store, record, existing);
  run.watch.storeMs += Math.max(0, now().getTime() - storeStart);
  retire();
  return { id: record.id, action: "stored", bytesFetched, record };
}

/**
 * Whether two extractions of one record say the same thing: equal apart from the
 * review mark and the instants the documents were fetched at, which a re-fetch of
 * the same bytes moves without changing a word.
 */
function sameContent(a: KaRecord, b: KaRecord): boolean {
  const comparable = (record: KaRecord): string =>
    canonicalJson({
      ...record,
      extraction: { ...record.extraction, review_status: "<mark>" },
      source_documents: record.source_documents.map(({ retrieved_at: _retrievedAt, ...document }) => document),
    });
  return comparable(a) === comparable(b);
}

/**
 * The id the record will be stored under, used here to find an existing one.
 *
 * It must be `makeRecordId` itself, not a copy of it. This was a verbatim
 * duplicate of the slug logic in `schema.ts`; the two agreed, but had they ever
 * drifted the lookup would have missed every stored record, `isUpToDate` would
 * never fire, and every sync would silently re-extract and rewrite the whole
 * corpus — with no error and no symptom beyond churn.
 */
function recordIdFor(request: { parliament: string; metadata: SourceMetadata }): string {
  return makeRecordId(request.parliament, request.metadata.legislative_period, request.metadata.reference);
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
 * Some fields need care, because extraction may fill in what the source left out.
 * `answered_by` is only compared where the source actually stated something —
 * `findMinistry` derives a ministry from the document text otherwise, and
 * comparing against that would rewrite every record on every run. The askers and
 * the dates are compared the same way, since `readAnfrageHead` reads them from a
 * Bayern paper whose feed states none. The same holds for a title or date a
 * validator rejected and cleared. (A value the source used to state and no longer
 * does is not noticed here; the extractor version, which moves whenever
 * extraction changes, re-extracts every record once anyway.)
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
  if (metadata.askers.length > 0 && canonicalJson(existing.askers) !== canonicalJson(metadata.askers)) return false;

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
  }
  return true;
}

export interface FetchedBytes {
  bytes: Buffer;
  retrievedAt: string;
  fromCache: boolean;
}

/** Why a document could not be fetched although nothing failed: the upstream said no. */
export type FetchGap =
  | { gap: "404" | "robots" | "not-pdf" | "glued" }
  /** Larger than the engine takes (`maxResponseBytes`); `bytes` when the response declared its size. */
  | { gap: "too-large"; limit: number; bytes?: number };

function gapText(fetched: FetchGap): string {
  if (fetched.gap === "not-pdf") return "answered something that is not a PDF; nothing was archived";
  if (fetched.gap === "glued") return "is several URLs glued together, not one; nothing was fetched";
  if (fetched.gap === "too-large") {
    // What to pass to fetch it: its own size rounded up to a MiB, or twice the cap.
    const MIB = 1024 * 1024;
    const suggest = fetched.bytes === undefined ? fetched.limit * 2 : Math.ceil(fetched.bytes / MIB) * MIB;
    const size = fetched.bytes === undefined ? "" : ` (${(fetched.bytes / MIB).toFixed(1)} MiB)`;
    return (
      `is larger than --max-response-bytes (${fetched.limit / MIB} MiB)${size}, so the record is stored without it; ` +
      `rerun with --max-response-bytes ${suggest} to fetch it`
    );
  }
  return fetched.gap === "404" ? "now answers 404" : "is disallowed by its host's robots.txt";
}

/**
 * Whether bytes are a PDF: the header `%PDF-` within the first 1024 bytes, where the
 * format allows it to sit. An HTML error page served with 200 under a document URL was
 * archived as the paper and stored as a record with every content field abstained,
 * reported as stored with no word.
 */
function looksLikePdf(bytes: Buffer): boolean {
  return bytes.subarray(0, 1024).includes("%PDF-");
}

/**
 * Fetch a document, or take it from the blob store when the upstream says it has
 * not changed. Returns a gap for a document the upstream no longer serves, or one
 * its host's robots.txt disallows and the operator did not override; either is a
 * gap in the record, not a reason to abort the whole sync.
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
  run: RunContext,
  expectPdf: boolean,
): Promise<FetchedBytes | FetchGap> {
  const { result, again } = await run.fetched.remember(url, () => fetchDocumentOnce(engine, store, url, now, httpCache, run, expectPdf));
  return again && !("gap" in result) ? { ...result, fromCache: true } : result;
}

async function fetchDocumentOnce(
  engine: FetchEngine,
  store: Store,
  url: string,
  now: () => Date,
  httpCache: SourceState["http_cache"],
  run: RunContext,
  expectPdf: boolean,
): Promise<FetchedBytes | FetchGap> {
  // A URL with a second scheme inside it is two links run together by the source
  // (the Parlamentsspiegel's `….pdfhttps://….doc`, issue #20). Asked for, it answered
  // 404 and was reported as a dead link; it is the source's markup that is broken.
  // Only a scheme in the path counts: one in the query (`?u=https://…`) is a value.
  if (/^https?:\/\/[^?#]*?https?:\/\//i.test(url)) return { gap: "glued" };
  // CONCEPT.md §7, at the one place every document URL passes through. A blob
  // already archived under a validator is still re-asked: the rule is about
  // requests, and a 304 is a request.
  if (!(await askRobots(run, url))) return { gap: "robots" };

  const cached = httpCache[url];
  const validators: { etag?: string; last_modified?: string } = {};
  if (cached?.etag !== undefined) validators.etag = cached.etag;
  if (cached?.last_modified !== undefined) validators.last_modified = cached.last_modified;
  const canRevalidate = cached?.sha256 !== undefined && store.hasBlob(cached.sha256);

  let response;
  try {
    response = await engine.get(url, {
      ...(canRevalidate ? { validators } : {}),
      // Every hop is a request too, on whatever host and path it lands.
      onRedirect: async (next) => {
        if (!(await askRobots(run, next))) throw new RedirectRefused(next);
      },
    });
  } catch (err) {
    if (err instanceof OpenKaApiError && err.status === 404) return { gap: "404" };
    // A document over the size cap used to fail the whole Anfrage, which was then
    // missing from the corpus (issue #23): it is a gap in the record, like a 404.
    if (err instanceof NetworkError && err.failure === "too_large") {
      return { gap: "too-large", limit: engine.maxResponseBytes, ...(err.bytes === undefined ? {} : { bytes: err.bytes }) };
    }
    if (err instanceof RedirectRefused) return { gap: "robots" };
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
  if (expectPdf && !looksLikePdf(response.body)) return { gap: "not-pdf" };
  const digest = store.putBlob(response.body);
  const entry: { etag?: string; last_modified?: string; sha256?: string } = { sha256: digest };
  if (response.etag !== undefined) entry.etag = response.etag;
  if (response.lastModified !== undefined) entry.last_modified = response.lastModified;
  httpCache[url] = entry;
  return { bytes: store.getBlob(digest), retrievedAt: isoInstant(now()), fromCache: false };
}

/** May `url` be requested? Asks the run's robots policy and warns once per origin. */
async function askRobots(run: RunContext, url: string): Promise<boolean> {
  const verdict = await run.robots.decide(url);
  if (verdict.note !== undefined) {
    const origin = new URL(url).origin;
    if (!run.notedOrigins.has(origin)) {
      run.notedOrigins.add(origin);
      run.warnings.push(verdict.note);
    }
  }
  return verdict.allowed;
}

/** A redirect hop that robots.txt disallows: the document is a gap, as if asked directly. */
class RedirectRefused extends Error {
  constructor(readonly url: string) {
    super(`redirect to ${url} is disallowed by its host's robots.txt`);
  }
}

/** ISO-8601 UTC to the second — the precision `retrieved_at` is specified at. */
export function isoInstant(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}
export { sourceStatus, type SourceStatusRow } from "./status.js";
export { SYNC_LIMIT_MIN, isSelective, normalizeSyncWindow, syncLimitProblem, syncPeriodProblem, syncRefsProblem, type SyncWindow } from "./window.js";
export { isComplete, noteOutcome, refIs, sameReference, selectRefs, type RefSelection } from "./select.js";
export {
  jobListProblem,
  planLanes,
  sourceListProblem,
  syncJobs,
  syncSources,
  type SourceOutcome,
  type SyncJob,
  type SyncJobsOptions,
  type SyncSourcesOptions,
} from "./many.js";
export { jobLabel, jobSpecProblem, parseJobSpec, windowOf, withDefaults, type SyncJobSpec } from "./jobs.js";
export { DEFAULT_KEYS, JOB_KEYS, LOG_PLACEHOLDERS, parseSyncQueue, type QueueJob, type SyncQueue } from "./queue.js";
export { parseToml, type TomlDocument, type TomlTable, type TomlValue } from "./toml.js";
export {
  DRY_RUN_SAMPLE,
  ESTIMATE_MIN_KNOWN,
  corpusEstimate,
  documentsToFetch,
  planSync,
  type SizeEstimate,
  type SyncPlan,
  type SyncPlanOptions,
} from "./plan.js";
export { countSources, type CountSourcesOptions, type SourceCountRow } from "./count.js";
