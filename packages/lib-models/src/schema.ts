// The canonical OpenKA record — the standardized format that is the heart of the
// project (CONCEPT.md §3). These TypeScript types are the source of truth; the
// JSON Schema in `json-schema.ts` is derived from them and kept in sync by a test.
//
// Two properties of this schema carry the project's trust guarantee:
//
//   * `extraction` records exactly how to reproduce a fact (extractor version,
//     model artifact hashes, input hash) — never how confident a model felt.
//   * `abstained_fields` is a first-class output. A record may publish with holes.
//     Holes are honest; invented content is not.

import { referenceSlug } from "./reference.js";

import type { ParliamentKey } from "./parliaments.js";

/** Bumped only by a reviewed decision — never by an agent (CONCEPT.md §8). */
export const SCHEMA_VERSION = "1.0";

/** The instruments this project collects. */
export const DocumentTypes = ["kleine_anfrage", "schriftliche_anfrage", "grosse_anfrage"] as const;
export type DocumentType = (typeof DocumentTypes)[number];

/**
 * The deterministic path that produced a record.
 *
 * `structured` — API / OParl / clean XML export: map fields directly.
 * `text_layer` — PDF with a real text layer: parse text + frozen layout rules.
 * `ocr`        — scanned / image-only PDF: pinned perceptual model, then parse.
 */
export const Tiers = ["structured", "text_layer", "ocr"] as const;
export type Tier = (typeof Tiers)[number];

export const ReviewStatuses = ["ok", "needs_review", "human_verified"] as const;
export type ReviewStatus = (typeof ReviewStatuses)[number];

/** The role a fetched document plays for a record. */
export const SourceDocumentRoles = ["question_pdf", "answer_pdf", "combined_pdf", "metadata"] as const;
export type SourceDocumentRole = (typeof SourceDocumentRoles)[number];

export interface Asker {
  name: string;
  party?: string;
  role?: string;
}

export interface AnsweredBy {
  ministry?: string;
  signatory?: string;
}

export interface Dates {
  /** ISO `YYYY-MM-DD`; absent when the extractor abstained on it. */
  submitted?: string;
  answered?: string;
}

export interface QaPair {
  /** The number as printed ("1", "2a", "3.1") — never renumbered by us. */
  number: string;
  question?: string;
  answer?: string;
}

export interface Markers {
  classified: boolean;
  contains_tables: boolean;
  attachments_referenced: string[];
}

export interface SourceDocument {
  role: SourceDocumentRole;
  url: string;
  sha256?: string;
  /** ISO-8601 UTC instant, second precision. */
  retrieved_at?: string;
  /**
   * False when the upstream URL is known not to be a durable reference — e.g.
   * Sachsen's document links, which expire after 15 minutes. The archived blob
   * in the corpus is then the only retrievable copy.
   */
  url_stable: boolean;
}

/** A perceptual model that ran at execution time, pinned and hashed. */
export interface ModelArtifact {
  name: string;
  version: string;
  weights_sha256?: string;
}

/** Reproducible provenance. Replaces any model/prompt/confidence block. */
export interface Extraction {
  tier: Tier;
  /** Git sha (or package version) of the adapter + parser that produced this. */
  extractor_version: string;
  model_artifacts: ModelArtifact[];
  /** sha256 of the exact bytes parsed. */
  input_sha256: string;
  reproducible: boolean;
  /** Did every expected field extract? */
  parse_complete: boolean;
  /** Field paths the extractor refused to guess, e.g. `qa[3].answer`. */
  abstained_fields: string[];
  review_status: ReviewStatus;
}

/** The canonical record. One per Kleine Anfrage (question plus its answer). */
export interface KaRecord {
  schema_version: string;
  /** `<parliament>-<period>-<reference-tail>`, e.g. `berlin-19-10006`. */
  id: string;
  parliament: ParliamentKey;
  document_type: DocumentType;
  /** Drucksachennummer exactly as printed, e.g. `19/10006`. */
  reference: string;
  legislative_period: number;
  title: string;
  askers: Asker[];
  answered_by: AnsweredBy;
  dates: Dates;
  qa: QaPair[];
  markers: Markers;
  /** The document's plain text, when a text tier ran. */
  full_text?: string;
  source_documents: SourceDocument[];
  extraction: Extraction;
}

/**
 * Build a record id from its parts. The reference tail keeps only the part after
 * the period separator and strips whitespace, so `19/10 006` and `19/10006` map to
 * the same id — the printed form stays in `reference`.
 */
export function makeRecordId(parliament: string, period: number, reference: string): string {
  return `${parliament}-${period}-${referenceSlug(reference)}`;
}
