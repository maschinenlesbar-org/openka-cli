// The deterministic tier stack with its abstention path (CONCEPT.md §5).
//
// One entry point, `extract()`, runs the tier an adapter declared. Every tier is a
// pure function of its inputs — the document bytes, the metadata the source
// supplied, and the extractor version — so re-running it yields byte-identical
// output. In particular nothing here reads the clock: `retrieved_at` travels with
// the fetched document, it is not observed during extraction.

import type { ParliamentKey } from "../models/parliaments.js";
import {
  SCHEMA_VERSION,
  makeRecordId,
  type AnsweredBy,
  type Asker,
  type Dates,
  type DocumentType,
  type Extraction,
  type KaRecord,
  type ModelArtifact,
  type QaPair,
  type SourceDocument,
  type SourceDocumentRole,
  type Tier,
} from "../models/schema.js";
import { sha256 } from "../repro/hash.js";
import { extractorVersion } from "../repro/version.js";
import { extractPdfImages, extractPdfText, PAGE_SEPARATOR } from "../pdf/index.js";
import { findMarkers, findMinistry } from "./metadata.js";
import { RULE_SETS, segmentQa, type SegmentationRules } from "./segment.js";
import { validateExtractedRecord } from "./validators.js";
import { abstainingPerceiver, type Perceiver } from "../perceive/perceiver.js";

/** A document the source fetched, with everything needed to record its provenance. */
export interface FetchedDocument {
  role: SourceDocumentRole;
  url: string;
  bytes: Buffer;
  /** False when the upstream URL is known not to be durable (expiring links). */
  urlStable: boolean;
  /** ISO-8601 UTC instant recorded at fetch time, not at extraction time. */
  retrievedAt?: string;
}

/** What the source already knows for certain, before any document is parsed. */
export interface SourceMetadata {
  reference: string;
  legislative_period: number;
  title: string;
  askers: Asker[];
  answered_by: AnsweredBy;
  dates: Dates;
}

export interface ExtractRequest {
  parliament: ParliamentKey;
  documentType: DocumentType;
  tier: Tier;
  metadata: SourceMetadata;
  documents: FetchedDocument[];
  /** Rule sets to try, in order. Defaults to the shared set. */
  ruleSets?: readonly SegmentationRules[];
  /** Only consulted by the `ocr` tier. Defaults to strict mode (abstain). */
  perceiver?: Perceiver;
  env?: NodeJS.ProcessEnv;
}

export interface ExtractResult {
  record: KaRecord;
  /** Human-readable reasons behind every abstention, for `ka review`. */
  notes: string[];
}

/** Collects abstentions so a tier never has to remember to flip two flags. */
export class Abstentions {
  private readonly fields = new Set<string>();
  readonly notes: string[] = [];

  add(field: string, reason: string): void {
    this.fields.add(field);
    this.notes.push(`${field}: ${reason}`);
  }

  note(reason: string): void {
    this.notes.push(reason);
  }

  get list(): string[] {
    return [...this.fields].sort();
  }

  get empty(): boolean {
    return this.fields.size === 0;
  }
}

/**
 * Run the declared tier and assemble a record.
 *
 * Returns a record even when extraction went badly: one with holes, an honest
 * `abstained_fields` list and `review_status: needs_review`. The only way to get
 * no record at all is to have no usable reference or period, since without those
 * the record has no identity to file it under.
 */
export async function extract(request: ExtractRequest): Promise<ExtractResult> {
  const abstentions = new Abstentions();
  const artifacts: ModelArtifact[] = [];
  const primary = pickPrimaryDocument(request.documents);

  let text: string | undefined;
  let tier: Tier = request.tier;

  if (request.tier === "ocr") {
    text = await runOcr(primary, request.perceiver ?? abstainingPerceiver, abstentions, artifacts);
  } else {
    // `structured` and `text_layer` run the same code deliberately. The difference
    // between them is a statement about the *source* (does it hand us fields, or
    // only a PDF?), not about what to do with a document once we hold one — and
    // keeping one code path is what lets `ka verify` re-run an extraction without
    // having to know which of the two the adapter declared.
    if (primary === undefined) {
      abstentions.add("full_text", "no document was fetched for this record");
    } else {
      text = tryText(primary.bytes, abstentions);
      if (text === undefined) abstentions.add("full_text", "no usable text layer");
    }
  }

  // The recorded tier is what actually happened, not what was asked for: a
  // structured source whose PDF parsed really did run the text-layer path.
  if (request.tier !== "ocr") tier = text === undefined ? "structured" : "text_layer";

  const qa: QaPair[] = [];
  if (text !== undefined && text.trim() !== "") {
    const flat = text.split(PAGE_SEPARATOR).join("\n");
    const segmented = segmentQa(flat, request.ruleSets ?? RULE_SETS);
    if (segmented.rules === undefined) {
      abstentions.add("qa", `no segmentation rule set matched (${segmented.rejections.join("; ")})`);
    } else {
      segmented.segments.forEach((segment, index) => {
        const pair: QaPair = { number: segment.number };
        if (segment.question !== undefined) pair.question = segment.question;
        else abstentions.add(`qa[${index}].question`, `rule set ${segmented.rules} found no question text`);
        if (segment.answer !== undefined) pair.answer = segment.answer;
        else abstentions.add(`qa[${index}].answer`, `rule set ${segmented.rules} found no answer text`);
        qa.push(pair);
      });
    }
  } else {
    abstentions.add("qa", "no document text was available to segment");
  }

  const answeredBy: AnsweredBy = { ...request.metadata.answered_by };
  if (answeredBy.ministry === undefined && text !== undefined) {
    const ministry = findMinistry(text);
    if (ministry !== undefined) answeredBy.ministry = ministry;
  }

  const markers = text !== undefined ? findMarkers(text) : { classified: false, contains_tables: false, attachments_referenced: [] };
  if (text === undefined) abstentions.add("markers", "markers need document text; none was available");

  const sourceDocuments: SourceDocument[] = request.documents
    .map((document) => {
      const entry: SourceDocument = {
        role: document.role,
        url: document.url,
        url_stable: document.urlStable,
        sha256: sha256(document.bytes),
      };
      if (document.retrievedAt !== undefined) entry.retrieved_at = document.retrievedAt;
      return entry;
    })
    .sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));

  const inputSha = primary !== undefined ? sha256(primary.bytes) : sha256(canonicalMetadataBytes(request.metadata));

  const extraction: Extraction = {
    tier,
    extractor_version: extractorVersion(request.env),
    model_artifacts: artifacts,
    input_sha256: inputSha,
    reproducible: true,
    parse_complete: abstentions.empty,
    abstained_fields: abstentions.list,
    review_status: abstentions.empty ? "ok" : "needs_review",
  };

  const record: KaRecord = {
    schema_version: SCHEMA_VERSION,
    id: makeRecordId(request.parliament, request.metadata.legislative_period, request.metadata.reference),
    parliament: request.parliament,
    document_type: request.documentType,
    reference: request.metadata.reference,
    legislative_period: request.metadata.legislative_period,
    title: request.metadata.title,
    askers: request.metadata.askers,
    answered_by: answeredBy,
    dates: request.metadata.dates,
    qa,
    markers,
    source_documents: sourceDocuments,
    extraction,
  };
  if (text !== undefined) record.full_text = text;

  // Validators are the last gate: a record that fails one abstains on the field
  // that failed rather than being published as if it were sound.
  const problems = validateExtractedRecord(record);
  for (const problem of problems) {
    abstentions.add(problem.path, problem.message);
  }
  if (problems.length > 0) {
    record.extraction.abstained_fields = abstentions.list;
    record.extraction.parse_complete = false;
    record.extraction.review_status = "needs_review";
    for (const problem of problems) clearField(record, problem.path);
  }

  return { record, notes: abstentions.notes };
}

/** The document a record's text comes from: the answer, else whatever there is. */
function pickPrimaryDocument(documents: FetchedDocument[]): FetchedDocument | undefined {
  return (
    documents.find((document) => document.role === "answer_pdf") ??
    documents.find((document) => document.role === "combined_pdf") ??
    documents.find((document) => document.role !== "metadata")
  );
}

function tryText(bytes: Buffer, abstentions: Abstentions): string | undefined {
  let result: ReturnType<typeof extractPdfText>;
  try {
    result = extractPdfText(bytes);
  } catch (err) {
    abstentions.note(`text layer unreadable: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
  for (const problem of result.problems) abstentions.note(`pdf: ${problem}`);
  if (result.imageOnly) {
    abstentions.note("pdf: no text layer (image-only document) — the ocr tier is needed");
    return undefined;
  }
  // A document where a tenth of the characters have no mapping is a document we
  // are reading wrong, not one with a few odd glyphs. Refuse it.
  if (result.unmappedRatio > 0.1) {
    abstentions.note(
      `pdf: ${(result.unmappedRatio * 100).toFixed(1)}% of character codes have no font mapping — text rejected`,
    );
    return undefined;
  }
  if (result.unmappedRatio > 0) {
    abstentions.note(`pdf: ${(result.unmappedRatio * 100).toFixed(2)}% of character codes were dropped as unmappable`);
  }
  return result.text;
}

async function runOcr(
  document: FetchedDocument | undefined,
  perceiver: Perceiver,
  abstentions: Abstentions,
  artifacts: ModelArtifact[],
): Promise<string | undefined> {
  if (document === undefined) {
    abstentions.add("full_text", "no document was fetched for this record");
    return undefined;
  }
  let images: ReturnType<typeof extractPdfImages>;
  try {
    images = extractPdfImages(document.bytes);
  } catch (err) {
    abstentions.add("full_text", `document unreadable: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
  for (const skipped of images.skipped) abstentions.note(`ocr: ${skipped}`);
  if (images.images.length === 0) {
    abstentions.add("full_text", "no embedded images to read; this document needs rendering, which the line does not do");
    return undefined;
  }

  try {
    artifacts.push(perceiver.artifact());
  } catch (err) {
    abstentions.add("full_text", err instanceof Error ? err.message : String(err));
    return undefined;
  }

  const pages = new Map<number, string[]>();
  let abstainedPages = 0;
  for (const image of images.images) {
    const outcome = await perceiver.recognize({ data: image.data, format: image.format, page: image.page });
    if (outcome.abstained) {
      abstainedPages++;
      abstentions.note(`ocr: ${outcome.reason ?? `page ${image.page} abstained`}`);
      continue;
    }
    const bucket = pages.get(image.page) ?? [];
    bucket.push(outcome.text);
    pages.set(image.page, bucket);
  }

  if (pages.size === 0) {
    abstentions.add("full_text", `every page abstained (${abstainedPages} of ${images.images.length})`);
    return undefined;
  }
  if (abstainedPages > 0) {
    abstentions.add("full_text", `${abstainedPages} of ${images.images.length} page images could not be read`);
  }
  return [...pages.keys()]
    .sort((a, b) => a - b)
    .map((page) => (pages.get(page) as string[]).join("\n"))
    .join(PAGE_SEPARATOR);
}

/** Bytes hashed as `input_sha256` when a record came from metadata alone. */
function canonicalMetadataBytes(metadata: SourceMetadata): Buffer {
  return Buffer.from(
    JSON.stringify([
      metadata.reference,
      metadata.legislative_period,
      metadata.title,
      metadata.askers,
      metadata.answered_by,
      metadata.dates,
    ]),
    "utf8",
  );
}

/** Blank the field a validator rejected, so a wrong value is never published. */
function clearField(record: KaRecord, path: string): void {
  if (path === "dates.answered") delete record.dates.answered;
  else if (path === "dates.submitted") delete record.dates.submitted;
  else if (path === "title") record.title = "";
  else if (path.startsWith("qa[")) {
    const match = /^qa\[(\d+)\]\.(question|answer)$/.exec(path);
    if (match) {
      const pair = record.qa[Number(match[1])];
      if (pair !== undefined) delete pair[match[2] as "question" | "answer"];
    }
  }
}
