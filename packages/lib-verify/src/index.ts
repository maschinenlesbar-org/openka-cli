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
  const stored = options.store.getRecord(id);
  const currentVersion = extractorVersion(options.env);
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
      return { ...base, reason: `archived bytes for ${document.url} (${document.sha256}) are missing` };
    }
    const fetched: FetchedDocument = {
      role: document.role,
      url: document.url,
      bytes: options.store.getBlob(document.sha256),
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

/**
 * Which tier to re-run. A record naming an OCR artifact came through the `ocr`
 * tier; everything else came through the shared structured/text-layer path, which
 * behaves identically for both declarations.
 */
function requestedTier(record: KaRecord): Tier {
  return record.extraction.model_artifacts.some((artifact) => artifact.name === "ocr") ? "ocr" : "text_layer";
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
