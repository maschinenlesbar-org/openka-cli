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
import { canonicalJsonLine } from "../repro/canonical.js";
import { sha256 } from "../repro/hash.js";
import { extractorVersion } from "../repro/version.js";
import { extractPdfImages, extractPdfText, PAGE_SEPARATOR } from "../pdf/index.js";
import { findMarkers, findMinistry } from "./metadata.js";
import {
  RULE_SETS,
  checkSegments,
  segmentQa,
  splitAtAnswerDivider,
  type QaSegment,
  type SegmentationRules,
} from "./segment.js";
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
/** A document that was parsed, with the role it plays for the record. */
interface ParsedDocument {
  role: SourceDocumentRole;
  text: string;
  sha256: string;
}

/**
 * The order documents are parsed and concatenated in. It is fixed so that
 * `full_text` and `input_sha256` do not depend on the order discovery happened to
 * list them in; within a role, the URL breaks ties.
 */
const ROLE_ORDER: SourceDocumentRole[] = ["question_pdf", "combined_pdf", "answer_pdf", "metadata"];

function parseOrder(documents: FetchedDocument[]): FetchedDocument[] {
  return [...documents]
    .filter((document) => document.role !== "metadata")
    .sort((a, b) => {
      const byRole = ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role);
      return byRole !== 0 ? byRole : a.url < b.url ? -1 : a.url > b.url ? 1 : 0;
    });
}

export async function extract(request: ExtractRequest): Promise<ExtractResult> {
  const abstentions = new Abstentions();
  const artifacts: ModelArtifact[] = [];
  const ordered = parseOrder(request.documents);

  const parsed: ParsedDocument[] = [];
  let tier: Tier = request.tier;

  if (request.tier === "ocr") {
    const primary = pickPrimaryDocument(request.documents);
    const text = await runOcr(primary, request.perceiver ?? abstainingPerceiver, abstentions, artifacts);
    if (text !== undefined && primary !== undefined) {
      parsed.push({ role: primary.role, text, sha256: sha256(primary.bytes) });
    }
  } else if (ordered.length === 0) {
    abstentions.add("full_text", "no document was fetched for this record");
  } else {
    // Every document is read, not just one. A Land that publishes the question and
    // the answer as separate papers — Saarland does — otherwise yields a record
    // with every answer and no questions, because only the answer paper was read.
    for (const document of ordered) {
      const text = tryText(document.bytes, abstentions);
      if (text === undefined) continue;
      parsed.push({ role: document.role, text, sha256: sha256(document.bytes) });
    }
    if (parsed.length === 0) abstentions.add("full_text", "no usable text layer");
  }

  // The recorded tier is what actually happened, not what was asked for: a
  // structured source whose PDF parsed really did run the text-layer path.
  if (request.tier !== "ocr") tier = parsed.length === 0 ? "structured" : "text_layer";

  const text = parsed.length === 0 ? undefined : parsed.map((document) => document.text).join(PAGE_SEPARATOR);
  const qa: QaPair[] = segmentDocuments(parsed, request.ruleSets ?? RULE_SETS, abstentions);

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

  // What was actually parsed. With one document that is its digest; with several it
  // is a digest over their digests in parse order, so the stamp still identifies
  // exactly the bytes this record was derived from. With none, the source metadata
  // is the input, because that is all the record was built from.
  const inputSha =
    parsed.length === 1
      ? (parsed[0] as ParsedDocument).sha256
      : parsed.length > 1
        ? sha256(parsed.map((document) => document.sha256).join("\n"))
        : sha256(canonicalMetadataBytes(request.metadata));

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

/**
 * Bytes hashed as `input_sha256` when a record came from metadata alone.
 *
 * Canonical JSON, not `JSON.stringify`: `askers`, `answered_by` and `dates` are
 * objects, and `JSON.stringify` emits their keys in insertion order. Two adapters
 * that build `dates` in a different order would then produce different digests for
 * identical data, which would make `input_sha256` — the field that says *these
 * exact bytes were parsed* — depend on how the value happened to be constructed.
 * This is the one place a digest is taken over a value rather than over bytes, so
 * it is the one place that has to go through the canonical form.
 */
function canonicalMetadataBytes(metadata: SourceMetadata): Buffer {
  return Buffer.from(
    canonicalJsonLine([
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

/**
 * Turn the parsed documents into question/answer pairs.
 *
 * One document is segmented directly. Several are segmented separately and then
 * merged by question number: questions come from the paper that asked them, answers
 * from the paper that answered them. A combined paper counts as both.
 *
 * The merge is checked with the same consistency rules a single reading has to
 * pass. Segmenting the parts permissively and validating the whole is what lets a
 * question paper — which legitimately contains no answers — be read at all, without
 * giving up the guards that stop a numbered table being read as a question list.
 */
function segmentDocuments(
  parsed: ParsedDocument[],
  ruleSets: readonly SegmentationRules[],
  abstentions: Abstentions,
): QaPair[] {
  if (parsed.length === 0) {
    abstentions.add("qa", "no document text was available to segment");
    return [];
  }

  const flatten = (text: string): string => text.split(PAGE_SEPARATOR).join("\n");

  if (parsed.length === 1) {
    const only = parsed[0] as ParsedDocument;
    const whole = flatten(only.text);
    const segmented = segmentQa(whole, ruleSets);
    if (segmented.rules !== undefined) {
      return collect(segmented.segments, segmented.rules, abstentions);
    }
    // A document that will not read as one text may still be two: Bayern prints the
    // question list, the word "Antwort", and then the questions again with the
    // replies. Splitting there turns it into the shape the merge already handles.
    const divided = splitAtAnswerDivider(whole, ruleSets);
    if (divided === undefined) {
      abstentions.add("qa", `no segmentation rule set matched (${segmented.rejections.join("; ")})`);
      return [];
    }
    return mergeReadings(
      [
        { role: "question_pdf", text: divided.questions },
        { role: "answer_pdf", text: divided.answers },
      ],
      ruleSets,
      abstentions,
      "the two halves of one document",
    );
  }

  return mergeReadings(
    parsed.map((document) => ({ role: document.role, text: flatten(document.text) })),
    ruleSets,
    abstentions,
    `${parsed.length} documents`,
  );
}

/** Segment several texts permissively and merge them by question number. */
function mergeReadings(
  parts: { role: SourceDocumentRole; text: string }[],
  ruleSets: readonly SegmentationRules[],
  abstentions: Abstentions,
  what: string,
): QaPair[] {
  const readings = parts.map((part) => ({
    role: part.role,
    result: segmentQa(part.text, ruleSets, { requireAnswers: false }),
  }));

  const order: string[] = [];
  const questions = new Map<string, string>();
  const answers = new Map<string, string>();
  const used: string[] = [];

  for (const reading of readings) {
    if (reading.result.rules === undefined) continue;
    used.push(`${reading.role}:${reading.result.rules}`);
    const asksQuestions = reading.role === "question_pdf" || reading.role === "combined_pdf";
    const givesAnswers = reading.role === "answer_pdf" || reading.role === "combined_pdf";
    for (const segment of reading.result.segments) {
      if (!order.includes(segment.number)) order.push(segment.number);
      if (asksQuestions && segment.question !== undefined && !questions.has(segment.number)) {
        questions.set(segment.number, segment.question);
      }
      if (givesAnswers && segment.answer !== undefined && !answers.has(segment.number)) {
        answers.set(segment.number, segment.answer);
      }
    }
  }

  if (used.length === 0) {
    const reasons = readings.flatMap((reading) => reading.result.rejections);
    abstentions.add("qa", `no segmentation rule set matched (${reasons.join("; ")})`);
    return [];
  }

  order.sort(compareNumbers);
  const merged: QaSegment[] = order.map((number) => {
    const segment: QaSegment = { number };
    const question = questions.get(number);
    const answer = answers.get(number);
    if (question !== undefined) segment.question = question;
    if (answer !== undefined) segment.answer = answer;
    return segment;
  });

  const problem = checkSegments(merged, used.join(" + "));
  if (problem !== undefined) {
    abstentions.add("qa", `the merged reading of ${what} is not believable (${problem})`);
    return [];
  }
  return collect(merged, used.join(" + "), abstentions);
}

/** Question numbers in their natural order: 1, 1a, 2, 10 — not lexicographic. */
function compareNumbers(a: string, b: string): number {
  const left = Number.parseInt(a, 10);
  const right = Number.parseInt(b, 10);
  if (left !== right) return left - right;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Turn segments into pairs, recording an abstention for every hole. */
function collect(segments: QaSegment[], label: string, abstentions: Abstentions): QaPair[] {
  const qa: QaPair[] = [];
  segments.forEach((segment, index) => {
    const pair: QaPair = { number: segment.number };
    if (segment.question !== undefined) pair.question = segment.question;
    else abstentions.add(`qa[${index}].question`, `rule set ${label} found no question text`);
    if (segment.answer !== undefined) pair.answer = segment.answer;
    else abstentions.add(`qa[${index}].answer`, `rule set ${label} found no answer text`);
    qa.push(pair);
  });
  return qa;
}
