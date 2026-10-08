// `ka verify` — proving reproducibility on demand.
//
// This is the command that makes the project's central claim checkable rather than
// asserted: take a stored record, re-run its extraction from the archived bytes,
// and compare the canonical JSON byte for byte. Anything other than an exact match
// is a finding, whether the cause is a changed extractor, a changed rule set, or a
// bug — the point is that you find out.

import { extract, type FetchedDocument } from "@maschinenlesbar.org/openka-lib-extract";
import type { KaRecord, Tier } from "@maschinenlesbar.org/openka-lib-models";
import type { Store } from "@maschinenlesbar.org/openka-lib-store";
import type { Perceiver } from "@maschinenlesbar.org/openka-lib-perceive";
import { canonicalJsonLine } from "@maschinenlesbar.org/openka-lib-repro";
import { extractorVersion } from "@maschinenlesbar.org/openka-lib-repro";
import { OpenKaError, StoreError, assertValid, intRangeProblem } from "@maschinenlesbar.org/openka-lib-errors";

/**
 * The fields `verifyRecord` takes from the stored record itself and hands back to
 * the extractor, so they reproduce whatever they say: the discovery metadata a
 * source supplied (a feed row, an aggregator row) is not archived, only the
 * documents are. What verify does check against archived bytes is everything the
 * extractor derives from them — `full_text`, `qa`, `markers`, the documents'
 * `sha256` and the `extraction` stamp — plus the record's validators.
 *
 * `answered_by` and `dates` are here even where the extractor first read them from
 * the paper (a ministry found in the text, Bayern's head): the stored value is
 * passed in and wins over the text, so an edit to it reproduces too. `reference`
 * and `legislative_period` are not: they make up the record id, so an edit to one
 * alone fails.
 *
 * An edited title, asker, party, date, ministry or document URL used to pass as
 * "reproduced byte-identically" with nothing saying these were never compared.
 */
export const UNCHECKED_FIELDS = [
  "title",
  "askers",
  "answered_by",
  "dates",
  "source_documents[].url",
  "source_documents[].role",
  "source_documents[].url_stable",
  "source_documents[].retrieved_at",
] as const;

export interface VerifyResult {
  id: string;
  /** True only when the re-extraction is byte-identical to the stored record. */
  ok: boolean;
  /**
   * What the check found, so an upgrade does not read as a broken corpus:
   * - `reproduced` — byte-identical;
   * - `version-only` — identical apart from `extraction.extractor_version`: the content
   *   reproduces, the record was stamped by another build (`ka reextract` restamps it);
   * - `differs` — the content differs (`contentDifferences`), whatever the version;
   * - `unreadable` — the record or its archived bytes could not be read;
   * - `unchecked` — nothing to compare: no such record, or an OCR record without its model.
   */
  verdict: "reproduced" | "version-only" | "differs" | "unreadable" | "unchecked";
  /** Short reason when `ok` is false. */
  reason?: string;
  /** Field paths whose re-extracted value differs from the stored one. */
  differences: string[];
  /** `differences` without the version stamp: what the content disagrees on. */
  contentDifferences: string[];
  /** The extractor version the record was produced with. */
  storedVersion: string;
  /** The extractor version this run used. */
  currentVersion: string;
  /**
   * Set when the stored record or the archived bytes it was built from could not
   * be read (a corrupt file, a missing or altered blob): the corpus is damaged,
   * which is a different finding from a record that does not reproduce.
   */
  unreadable?: true;
}

/** The path of the version stamp: the one field an upgrade moves on every record. */
export const VERSION_PATH = "extraction.extractor_version";

export interface VerifyOptions {
  store: Store;
  perceiver?: Perceiver;
  env?: NodeJS.ProcessEnv;
}

/** What re-running a stored record's extraction gave: the fresh record, or why there is none. */
export type Reextraction =
  | { record: KaRecord }
  | { unreadable: true; reason: string }
  | { unchecked: true; reason: string };

/**
 * Re-run a stored record's extraction from its archived bytes, with the metadata the
 * record carries (`UNCHECKED_FIELDS`), the way `sync()` ran it. No request is made.
 * Missing or altered bytes are `unreadable`; an OCR record without a perceiver is
 * `unchecked`. A `human_verified` mark is carried across: it records that a person
 * checked the holes, which re-extraction cannot reproduce.
 */
export async function reextractStored(stored: KaRecord, options: VerifyOptions, how: { keepMark?: boolean } = {}): Promise<Reextraction> {
  const documents: FetchedDocument[] = [];
  for (const document of stored.source_documents) {
    if (document.sha256 === undefined) continue;
    if (!options.store.hasBlob(document.sha256)) {
      return { unreadable: true, reason: `archived bytes for ${document.url} (${document.sha256}) are missing` };
    }
    let bytes: Buffer;
    try {
      bytes = options.store.getBlob(document.sha256);
    } catch (err) {
      // Bytes that no longer match their digest (or cannot be read at all) cannot
      // be re-extracted into anything meaningful; "the extractor is
      // non-deterministic" would name the wrong culprit.
      const reason = err instanceof Error ? err.message : String(err);
      return { unreadable: true, reason: `archived bytes for ${document.url} are unreadable: ${reason}` };
    }
    const fetched: FetchedDocument = {
      role: document.role,
      url: document.url,
      bytes,
      urlStable: document.url_stable,
    };
    if (document.retrieved_at !== undefined) fetched.retrievedAt = document.retrieved_at;
    documents.push(fetched);
  }

  const tier = requestedTier(stored);
  if (tier === "ocr" && options.perceiver === undefined) {
    return {
      unchecked: true,
      reason:
        "this record was produced with an OCR model; re-extracting it needs the same pinned model " +
        `(${stored.extraction.model_artifacts.map((artifact) => artifact.version).join(", ") || "unnamed"})`,
    };
  }

  const { record } = await extract({
    parliament: stored.parliament,
    documentType: stored.document_type,
    tier,
    metadata: {
      reference: stored.reference,
      legislative_period: stored.legislative_period,
      title: stored.title,
      askers: stored.askers,
      answered_by: stored.answered_by,
      dates: stored.dates,
    },
    documents,
    ...(options.perceiver !== undefined ? { perceiver: options.perceiver } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
  });

  // `human_verified` is the one field a human sets and re-extraction cannot
  // reproduce: it records that a person checked the holes, not that they were
  // filled. Carrying it across keeps `ka review --mark-verified` from turning every
  // reviewed record into a verification failure, and it is the only exception —
  // everything else must match byte for byte.
  if (how.keepMark !== false && stored.extraction.review_status === "human_verified" && record.extraction.review_status === "needs_review") {
    record.extraction.review_status = "human_verified";
  }
  return { record };
}

/**
 * Re-extract one record and compare. Missing archived bytes are reported as a
 * failure to verify rather than a mismatch: a claim that cannot be checked is not
 * the same as a claim that is wrong, and conflating the two would be dishonest in
 * the direction that flatters us.
 *
 * The content is always compared, also when the record was stamped by another build:
 * a record that differs only in `extraction.extractor_version` is `version-only`,
 * one whose content differs is `differs` with the paths, whatever the version.
 */
export async function verifyRecord(id: string, options: VerifyOptions): Promise<VerifyResult> {
  // Not a failed row per record: with the blob directory unplugged, nothing can be
  // verified, and that is said once (StoreError) rather than as N missing documents.
  options.store.assertBlobStore?.();
  const currentVersion = extractorVersion(options.env);
  const none = { differences: [], contentDifferences: [] };
  let stored: KaRecord | undefined;
  try {
    stored = options.store.getRecord(id);
  } catch (err) {
    // A record file that will not parse is one failed row, like every other
    // record that cannot be checked — not a throw that ends a corpus-wide run at
    // the first damaged file, leaving the rest unchecked.
    if (!(err instanceof StoreError)) throw err;
    return { id, ok: false, verdict: "unreadable", unreadable: true, reason: err.message, ...none, storedVersion: "unknown", currentVersion };
  }
  if (stored === undefined) {
    return { id, ok: false, verdict: "unchecked", reason: "no such record", ...none, storedVersion: "", currentVersion };
  }
  const base = { id, ok: false, ...none, storedVersion: stored.extraction.extractor_version, currentVersion };

  const fresh = await reextractStored(stored, options);
  if ("unreadable" in fresh) return { ...base, verdict: "unreadable", unreadable: true, reason: fresh.reason };
  if ("unchecked" in fresh) return { ...base, verdict: "unchecked", reason: fresh.reason };
  const record = fresh.record;

  if (canonicalJsonLine(stored) === canonicalJsonLine(record)) return { ...base, ok: true, verdict: "reproduced" };

  const differences = diffPaths(stored as unknown as Record<string, unknown>, record as unknown as Record<string, unknown>);
  const contentDifferences = differences.filter((path) => path !== VERSION_PATH);
  const sameVersion = stored.extraction.extractor_version === currentVersion;
  if (contentDifferences.length === 0) {
    return {
      ...base,
      verdict: "version-only",
      reason: `produced by ${stored.extraction.extractor_version}, content identical under ${currentVersion}`,
      differences,
    };
  }
  return {
    ...base,
    verdict: "differs",
    reason: sameVersion
      ? "re-extraction produced different bytes with the same extractor version"
      : `record was produced by ${stored.extraction.extractor_version}, this build is ${currentVersion}`,
    differences,
    contentDifferences,
  };
}

/** How many records `verifyCorpus` checks when it is given neither ids nor `all`. */
export const DEFAULT_VERIFY_SAMPLE = 25;

/**
 * An evenly spaced selection across a sorted list — the default corpus sample.
 *
 * `slice(0, n)` was not a sample: record ids sort by parliament, so it checked the
 * same alphabetically-first records on every run and whole Länder were never
 * verified at all. Stepping through the range keeps the choice deterministic (the
 * same corpus always yields the same sample, which a reproducibility check needs)
 * while covering every part of it.
 */
export function evenSample(ids: string[], count: number): string[] {
  if (count >= ids.length) return ids;
  const step = ids.length / count;
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(ids[Math.floor(i * step)] as string);
  return out;
}

export interface VerifyCorpusOptions extends VerifyOptions {
  /** Exactly these records. Wins over `all` and `limit`. */
  ids?: string[];
  /** Every record in the corpus. Wins over `limit`. */
  all?: boolean;
  /** Sample size when neither `ids` nor `all` is given: `DEFAULT_VERIFY_SAMPLE`, an integer >= 1. */
  limit?: number;
}

/** What `ka verify --json` prints. */
export interface CorpusVerifyReport {
  checked: number;
  reproduced: number;
  /** Rows identical apart from the version stamp: stamped by another build, content reproduces. */
  versionOnly: number;
  /** Rows whose content differs. */
  differs: number;
  /** Rows whose stored record could not be read at all. */
  unreadable: number;
  /** What no row was checked against archived bytes: `UNCHECKED_FIELDS`. */
  unchecked: string[];
  results: VerifyResult[];
}

/**
 * Verify a set of records — given ids, every record, or an even sample — and
 * tally the results; the tally names the fields it could not check
 * (`unchecked`, see `UNCHECKED_FIELDS`). A corrupt record is a failed row (`unreadable`), and the run
 * carries on past it. A corpus with no records to check is an `OpenKaError`
 * ("No records in …"), never a vacuous pass; a `limit` below 1 is refused with
 * `OpenKaValidationError`. The verdict on the tally is `assertVerified`.
 */
export async function verifyCorpus(options: VerifyCorpusOptions): Promise<CorpusVerifyReport> {
  if (options.limit !== undefined) assertValid("limit", options.limit, intRangeProblem(1));
  const { store } = options;
  store.assertBlobStore?.();
  const ids =
    options.ids !== undefined
      ? options.ids
      : options.all === true
        ? store.recordIds()
        : evenSample(store.recordIds(), options.limit ?? DEFAULT_VERIFY_SAMPLE);
  if (ids.length === 0) throw new OpenKaError(`No records in ${store.root}`);
  const single: VerifyOptions = {
    store,
    ...(options.perceiver === undefined ? {} : { perceiver: options.perceiver }),
    ...(options.env === undefined ? {} : { env: options.env }),
  };
  const results: VerifyResult[] = [];
  for (const id of ids) results.push(await verifyRecord(id, single));
  return {
    checked: results.length,
    reproduced: results.filter((result) => result.ok).length,
    versionOnly: results.filter((result) => result.verdict === "version-only").length,
    differs: results.filter((result) => result.verdict === "differs").length,
    unreadable: results.filter((result) => result.unreadable === true).length,
    unchecked: [...UNCHECKED_FIELDS],
    results,
  };
}

/**
 * Every record's content reproduces, but some were stamped by another extractor
 * version than this build's: not a broken corpus, an un-restamped one (`ka reextract`).
 * `ka verify` exits 5 for it, apart from 1 for content that differs.
 */
export class VersionOnlyError extends OpenKaError {
  constructor(message: string) {
    super(message);
    this.name = "VersionOnlyError";
  }
}

/**
 * The verdict on a corpus run, worst first: a `StoreError` when any record or its
 * archived bytes could not be read (the corpus is damaged; `ka verify` exits 3, as
 * `ka open` does for the same missing blob); an `OpenKaError` when any content
 * differs or could not be checked; a `VersionOnlyError` when every content
 * reproduces but some carry another build's version stamp.
 */
export function assertVerified(report: CorpusVerifyReport): void {
  const failed = report.checked - report.reproduced;
  if (report.unreadable > 0) {
    throw new StoreError(`${failed} record(s) did not reproduce, ${report.unreadable} of them unreadable`);
  }
  if (failed > report.versionOnly) throw new OpenKaError(`${failed - report.versionOnly} record(s) did not reproduce`);
  if (report.versionOnly > 0) {
    throw new VersionOnlyError(
      `${report.versionOnly} record(s) reproduce in content but were stamped by another extractor version; ` +
        "`ka reextract` restamps them",
    );
  }
}

/**
 * Which tier to re-run. A record naming an OCR artifact came through the `ocr`
 * tier; everything else came through the shared structured/text-layer path, which
 * behaves identically for both declarations.
 */
function requestedTier(record: KaRecord): Tier {
  if (record.extraction.model_artifacts.some((artifact) => artifact.name === "ocr")) return "ocr";
  // A record with nothing parsed carries its source's tier; asking for it again is
  // what reproduces it. With text parsed, either request records text_layer.
  return record.extraction.tier === "structured" ? "structured" : "text_layer";
}

/** Field paths that differ between two records, deepest path first seen. */
export function diffPaths(a: unknown, b: unknown, path = ""): string[] {
  if (Object.is(a, b)) return [];
  const aIsObject = typeof a === "object" && a !== null;
  const bIsObject = typeof b === "object" && b !== null;
  if (!aIsObject || !bIsObject) return [path === "" ? "<root>" : path];

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return [path === "" ? "<root>" : path];
    const out: string[] = [];
    const length = Math.max(a.length, b.length);
    for (let i = 0; i < length; i++) out.push(...diffPaths(a[i], b[i], `${path}[${i}]`));
    return out;
  }

  const keys = [...new Set([...Object.keys(a as object), ...Object.keys(b as object)])].sort();
  const out: string[] = [];
  for (const key of keys) {
    const child = path === "" ? key : `${path}.${key}`;
    out.push(...diffPaths((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], child));
  }
  return out;
}

export { reextractRecords, type ReextractOptions, type ReextractOutcome, type ReextractReport, type ReextractResult } from "./reextract.js";
