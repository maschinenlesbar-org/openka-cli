// discover → fetch → extract → normalize → store.
//
// The pipeline is idempotent and keyed on content: a document whose bytes are
// already in the blob store is not re-fetched, and a record whose inputs and
// extractor version are unchanged is not re-extracted. Re-running a sync over a
// window that has not moved therefore does nothing, costs one conditional request
// per feed, and leaves the corpus byte-identical.

import { OpenKaApiError, OpenKaError, UsageError } from "@maschinenlesbar.org/openka-lib-errors";
import type { FetchEngine } from "@maschinenlesbar.org/openka-lib-http";
import { makeRecordId, parseReference, periodNumber, referenceSlug, type KaRecord } from "@maschinenlesbar.org/openka-lib-models";
import { indexRecord, withCorpusLock, type SourceState, type Store } from "@maschinenlesbar.org/openka-lib-store";
import { extract, type FetchedDocument, type SourceMetadata } from "@maschinenlesbar.org/openka-lib-extract";
import { canonicalJson, extractorVersion, sha256 } from "@maschinenlesbar.org/openka-lib-repro";
import type { Perceiver } from "@maschinenlesbar.org/openka-lib-perceive";
import { RobotsPolicy, type DocRef, type Source } from "@maschinenlesbar.org/openka-lib-source";
import { normalizeSyncWindow } from "./window.js";

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
}

/**
 * How many refs one catalog batch covers. The catalog is persisted at the end of
 * each, so a run killed outright (SIGKILL, a power cut) loses the catalog rows of
 * at most this many stored records — and the next sync over the window, or `ka
 * reindex`, puts those back. One batch for the whole run lost every row of a long
 * sync to a Ctrl-C, while its records and postings stayed on disk.
 */
export const CATALOG_CHECKPOINT = 25;

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
  /**
   * Unchanged records that were on disk but missing from the catalog — what an
   * interrupted run left behind — and were indexed again. Counted in `unchanged`.
   */
  recatalogued: number;
  /** True when `signal` stopped the run before every ref was handled. */
  interrupted: boolean;
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
  const { source, store, engine } = options;
  if (source.minHostIntervalMs !== undefined) engine.raiseMinHostInterval(source.minHostIntervalMs);
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
    recatalogued: 0,
    interrupted: false,
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
      ...(options.ignoreRobots === true ? { ignoreRobots: true } : {}),
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
  options.onDiscovered?.(discovered.refs.length);

  // Conditional-request state travels through the run and is persisted once at
  // the end, so an interrupted sync cannot leave a validator recorded for bytes
  // that were never stored.
  const httpCache = { ...(discovered.state ?? state).http_cache };
  const run: RunContext = {
    robots: new RobotsPolicy(engine, options.ignoreRobots === true),
    warnings: report.warnings,
    notedOrigins: new Set(),
  };

  // One catalog write per `CATALOG_CHECKPOINT` refs rather than one per record:
  // the catalog grows with the corpus, and rewriting it per record made a sync
  // quadratic in catalog bytes. Each batch also flushes when the loop throws.
  const refs = discovered.refs;
  let index = 0;
  const handle = async (ref: DocRef): Promise<void> => {
    index++;
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
      options.onProgress?.({ index, total: refs.length, id: outcome.id, action: outcome.action });
    } catch (err) {
      report.failed++;
      const message = err instanceof Error ? err.message : String(err);
      report.errors.push(`${ref.reference}: ${message}`);
      options.onProgress?.({ index, total: refs.length, id: ref.reference, action: "failed", detail: message });
    }
  };
  for (let start = 0; start < refs.length && !report.interrupted; start += CATALOG_CHECKPOINT) {
    await store.batchCatalog(async () => {
      for (const ref of refs.slice(start, start + CATALOG_CHECKPOINT)) {
        if (options.signal?.aborted === true) {
          report.interrupted = true;
          return;
        }
        await handle(ref);
      }
    });
  }

  // A run stopped early still records the validators of what it stored: every one
  // of them belongs to bytes that are in the blob store. It does not count as a
  // success, since the window was not covered.
  const nextState = { ...(discovered.state ?? state), http_cache: httpCache, last_sync: startedAt };
  if (report.interrupted) {
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
  robots: RobotsPolicy;
  warnings: string[];
  /** Hosts already warned about, so a hundred documents on one host warn once. */
  notedOrigins: Set<string>;
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

  const documents: FetchedDocument[] = [];
  let bytesFetched = 0;

  if (!options.metadataOnly) {
    for (const wanted of ref.documents) {
      const fetched = await fetchDocument(engine, store, wanted.url, now, httpCache, run);
      if ("gap" in fetched) {
        // The upstream no longer hands this document out — a 404, or a robots.txt
        // that now disallows it. A record that already holds it must not be
        // re-extracted from nothing: that overwrote complete records with empty
        // ones and reported them as stored, and `ka verify` then "reproduced" the
        // empty one. The archived bytes are what the record was built from, so
        // they are read again, dated when they were actually retrieved.
        const archived = existing?.source_documents.find((document) => document.url === wanted.url);
        if (archived?.sha256 === undefined) {
          if (fetched.gap === "404") run.warnings.push(`${ref.reference}: ${wanted.url} ${gapText(fetched.gap)}`);
          continue;
        }
        if (!store.hasBlob(archived.sha256)) {
          throw new OpenKaError(
            `${wanted.url} ${gapText(fetched.gap)}, and the archived copy the stored record was built from is missing; ` +
              "the stored record was left as it was",
          );
        }
        run.warnings.push(
          `${ref.reference}: ${wanted.url} ${gapText(fetched.gap)}; ` +
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
      return { id: existing.id, action: "unchanged", bytesFetched, recatalogued: true };
    }
    return { id: existing.id, action: "unchanged", bytesFetched };
  }

  const { record } = await extract(request);
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
  store.putRecord(record);
  // The postings in the index are the stored record's, which putRecord just replaced.
  indexRecord(store, record, existing);
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
 * Do two references name the same Drucksache? Compared as values where both parse,
 * so a Land that pads the period one day (`08/980`) and not the next (`8/980`) is
 * a correction of the same record, not a collision with another.
 */
function sameReference(a: string, b: string): boolean {
  if (a === b) return true;
  const left = parseReference(a);
  const right = parseReference(b);
  if (left === undefined || right === undefined) return false;
  return periodNumber(left) === periodNumber(right) && left.number === right.number;
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

interface FetchedBytes {
  bytes: Buffer;
  retrievedAt: string;
  fromCache: boolean;
}

/** Why a document could not be fetched although nothing failed: the upstream said no. */
type FetchGap = { gap: "404" | "robots" };

function gapText(gap: FetchGap["gap"]): string {
  return gap === "404" ? "now answers 404" : "is disallowed by its host's robots.txt";
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
): Promise<FetchedBytes | FetchGap> {
  // CONCEPT.md §7, at the one place every document URL passes through. A blob
  // already archived under a validator is still re-asked: the rule is about
  // requests, and a 304 is a request.
  const verdict = await run.robots.decide(url);
  if (verdict.note !== undefined) {
    const origin = new URL(url).origin;
    if (!run.notedOrigins.has(origin)) {
      run.notedOrigins.add(origin);
      run.warnings.push(verdict.note);
    }
  }
  if (!verdict.allowed) return { gap: "robots" };

  const cached = httpCache[url];
  const validators: { etag?: string; last_modified?: string } = {};
  if (cached?.etag !== undefined) validators.etag = cached.etag;
  if (cached?.last_modified !== undefined) validators.last_modified = cached.last_modified;
  const canRevalidate = cached?.sha256 !== undefined && store.hasBlob(cached.sha256);

  let response;
  try {
    response = await engine.get(url, canRevalidate ? { validators } : {});
  } catch (err) {
    if (err instanceof OpenKaApiError && err.status === 404) return { gap: "404" };
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
export { sourceStatus, type SourceStatusRow } from "./status.js";
export { SYNC_LIMIT_MIN, normalizeSyncWindow, syncLimitProblem, syncPeriodProblem, type SyncWindow } from "./window.js";
export { planLanes, sourceListProblem, syncSources, type SourceOutcome, type SyncSourcesOptions } from "./many.js";
