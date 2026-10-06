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

export interface VerifyResult {
  id: string;
  ok: boolean;
  /** Short reason when `ok` is false. */
  reason?: string;
  /** Field paths whose re-extracted value differs from the stored one. */
  differences: string[];
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

export interface VerifyOptions {
  store: Store;
  perceiver?: Perceiver;
  env?: NodeJS.ProcessEnv;
}

/**
 * Re-extract one record and compare. Missing archived bytes are reported as a
 * failure to verify rather than a mismatch: a claim that cannot be checked is not
 * the same as a claim that is wrong, and conflating the two would be dishonest in
 * the direction that flatters us.
 */
export async function verifyRecord(id: string, options: VerifyOptions): Promise<VerifyResult> {
  const currentVersion = extractorVersion(options.env);
  let stored: KaRecord | undefined;
  try {
    stored = options.store.getRecord(id);
  } catch (err) {
    // A record file that will not parse is one failed row, like every other
    // record that cannot be checked — not a throw that ends a corpus-wide run at
    // the first damaged file, leaving the rest unchecked.
    if (!(err instanceof StoreError)) throw err;
    return { id, ok: false, unreadable: true, reason: err.message, differences: [], storedVersion: "unknown", currentVersion };
  }
  if (stored === undefined) {
    return { id, ok: false, reason: "no such record", differences: [], storedVersion: "", currentVersion };
  }
  const base: VerifyResult = {
    id,
    ok: false,
    differences: [],
    storedVersion: stored.extraction.extractor_version,
    currentVersion,
  };

  const documents: FetchedDocument[] = [];
  for (const document of stored.source_documents) {
    if (document.sha256 === undefined) continue;
    if (!options.store.hasBlob(document.sha256)) {
      return { ...base, unreadable: true, reason: `archived bytes for ${document.url} (${document.sha256}) are missing` };
    }
    let bytes: Buffer;
    try {
      bytes = options.store.getBlob(document.sha256);
    } catch (err) {
      // Bytes that no longer match their digest (or cannot be read at all) cannot
      // be re-extracted into anything meaningful; "the extractor is
      // non-deterministic" would name the wrong culprit.
      const reason = err instanceof Error ? err.message : String(err);
      return { ...base, unreadable: true, reason: `archived bytes for ${document.url} are unreadable: ${reason}` };
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
      ...base,
      reason:
        "this record was produced with an OCR model; verifying it needs the same pinned model " +
        `(${stored.extraction.model_artifacts.map((artifact) => artifact.version).join(", ") || "unnamed"})`,
    };
  }

  const request = {
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
  };

  const { record } = await extract(request);

  // `human_verified` is the one field a human sets and re-extraction cannot
  // reproduce: it records that a person checked the holes, not that they were
  // filled. Carrying it across keeps `ka review --mark-verified` from turning every
  // reviewed record into a verification failure, and it is the only exception —
  // everything else must match byte for byte.
  if (stored.extraction.review_status === "human_verified" && record.extraction.review_status === "needs_review") {
    record.extraction.review_status = "human_verified";
  }

  const storedBytes = canonicalJsonLine(stored);
  const freshBytes = canonicalJsonLine(record);
  if (storedBytes === freshBytes) return { ...base, ok: true };

  return {
    ...base,
    reason:
      stored.extraction.extractor_version === currentVersion
        ? "re-extraction produced different bytes with the same extractor version"
        : `record was produced by ${stored.extraction.extractor_version}, this build is ${currentVersion}`,
    differences: diffPaths(stored as unknown as Record<string, unknown>, record as unknown as Record<string, unknown>),
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
  /** Rows whose stored record could not be read at all. */
  unreadable: number;
  results: VerifyResult[];
}

/**
 * Verify a set of records — given ids, every record, or an even sample — and
 * tally the results. A corrupt record is a failed row (`unreadable`), and the run
 * carries on past it. A corpus with no records to check is an `OpenKaError`
 * ("No records in …"), never a vacuous pass; a `limit` below 1 is refused with
 * `OpenKaValidationError`. The verdict on the tally is `assertVerified`.
 */
export async function verifyCorpus(options: VerifyCorpusOptions): Promise<CorpusVerifyReport> {
  if (options.limit !== undefined) assertValid("limit", options.limit, intRangeProblem(1));
  const { store } = options;
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
    unreadable: results.filter((result) => result.unreadable === true).length,
    results,
  };
}

/**
 * The verdict on a corpus run: a `StoreError` when any record or its archived
 * bytes could not be read (the corpus is damaged; `ka verify` exits 3, as `ka
 * open` does for the same missing blob), else an `OpenKaError` when any did not
 * reproduce.
 */
export function assertVerified(report: CorpusVerifyReport): void {
  const failed = report.checked - report.reproduced;
  if (report.unreadable > 0) {
    throw new StoreError(`${failed} record(s) did not reproduce, ${report.unreadable} of them unreadable`);
  }
  if (failed > 0) throw new OpenKaError(`${failed} record(s) did not reproduce`);
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
