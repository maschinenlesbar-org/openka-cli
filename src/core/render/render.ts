// Renderings of the one canonical record: JSON, JSON-LD, CSV, Markdown and Atom.
//
// Every renderer shares one rule about holes: an abstained field is rendered as
// *visibly* absent, never as an empty value that reads like "there was nothing
// there". CSV gets an explicit `abstained_fields` column, Markdown prints the
// abstentions, and the feed says so in the entry. A hole a consumer cannot see is
// the same problem as an invented value.

import { canonicalJson, canonicalJsonLine } from "../repro/canonical.js";
import type { KaRecord } from "../models/schema.js";
import { parliamentByKey } from "../models/parliaments.js";

export const RENDER_FORMATS = ["json", "jsonld", "csv", "md", "text"] as const;
export type RenderFormat = (typeof RENDER_FORMATS)[number];

/** Canonical JSON — the same bytes that are stored and hashed. */
export function renderJson(record: KaRecord): string {
  return canonicalJsonLine(record);
}

/**
 * JSON-LD using schema.org terms, so the corpus drops into a triple store without
 * a bespoke vocabulary. `openka:` terms cover what schema.org has no word for —
 * the abstentions and the provenance, which are the parts worth publishing.
 */
export function renderJsonLd(record: KaRecord): string {
  const parliament = parliamentByKey(record.parliament);
  const document: Record<string, unknown> = {
    "@context": {
      "@vocab": "https://schema.org/",
      openka: "https://maschinenlesbar-org.github.io/openka-cli/ns#",
    },
    "@type": "Legislation",
    "@id": `urn:openka:${record.id}`,
    identifier: record.reference,
    name: record.title,
    inLanguage: "de",
    legislationJurisdiction: parliament?.label ?? record.parliament,
    "openka:documentType": record.document_type,
    "openka:legislativePeriod": record.legislative_period,
    author: record.askers.map((asker) => ({
      "@type": "Person",
      name: asker.name,
      ...(asker.party === undefined ? {} : { affiliation: { "@type": "Organization", name: asker.party } }),
      ...(asker.role === undefined ? {} : { jobTitle: asker.role }),
    })),
    ...(record.answered_by.ministry === undefined
      ? {}
      : { "openka:answeredBy": { "@type": "GovernmentOrganization", name: record.answered_by.ministry } }),
    ...(record.dates.submitted === undefined ? {} : { dateCreated: record.dates.submitted }),
    ...(record.dates.answered === undefined ? {} : { datePublished: record.dates.answered }),
    "openka:qa": record.qa.map((pair) => ({
      "@type": "Question",
      identifier: pair.number,
      ...(pair.question === undefined ? {} : { text: pair.question }),
      ...(pair.answer === undefined ? {} : { acceptedAnswer: { "@type": "Answer", text: pair.answer } }),
    })),
    associatedMedia: record.source_documents.map((source) => ({
      "@type": "MediaObject",
      contentUrl: source.url,
      encodingFormat: "application/pdf",
      "openka:role": source.role,
      ...(source.sha256 === undefined ? {} : { "openka:sha256": source.sha256 }),
      "openka:urlStable": source.url_stable,
    })),
    "openka:extraction": record.extraction,
  };
  return canonicalJsonLine(document);
}

/**
 * Characters that make a spreadsheet read a cell as a formula rather than as text.
 * Quoting does not stop it: Excel and LibreOffice both evaluate `=HYPERLINK(...)`
 * inside a quoted CSV field on open.
 */
const CSV_FORMULA_LEAD = /^[=+\-@\t\r]/;

/**
 * RFC 4180 quoting: always quote, so a field containing a newline stays one field.
 *
 * A cell that would start a formula additionally gets a leading apostrophe, the
 * conventional way to force a spreadsheet to treat it as text. That does alter the
 * value, which this project otherwise never does — but a title is upstream text we
 * do not control, and the same reasoning that strips terminal escapes out of server
 * responses applies to handing a parliament's text to Excel as executable. CSV is
 * already the lossy rendering (it drops the Q/A text); `json`, `jsonl` and `jsonld`
 * carry every value exactly as extracted.
 */
export function csvCell(value: string): string {
  const safe = CSV_FORMULA_LEAD.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

export const CSV_COLUMNS = [
  "id",
  "parliament",
  "document_type",
  "reference",
  "legislative_period",
  "title",
  "askers",
  "parties",
  "ministry",
  "submitted",
  "answered",
  "questions",
  "tier",
  "review_status",
  "abstained_fields",
  "source_url",
] as const;

export function csvHeader(): string {
  return CSV_COLUMNS.join(",");
}

/**
 * One row per record. Flattening loses the Q/A pairs, so the row carries their
 * count and the `abstained_fields` list rather than pretending the text is there;
 * a consumer who needs the text uses the JSON rendering.
 */
export function renderCsvRow(record: KaRecord): string {
  const cells: Record<(typeof CSV_COLUMNS)[number], string> = {
    id: record.id,
    parliament: record.parliament,
    document_type: record.document_type,
    reference: record.reference,
    legislative_period: String(record.legislative_period),
    title: record.title,
    askers: record.askers.map((asker) => asker.name).join("; "),
    parties: [...new Set(record.askers.map((asker) => asker.party).filter(Boolean))].join("; "),
    ministry: record.answered_by.ministry ?? "",
    submitted: record.dates.submitted ?? "",
    answered: record.dates.answered ?? "",
    questions: String(record.qa.length),
    tier: record.extraction.tier,
    review_status: record.extraction.review_status,
    abstained_fields: record.extraction.abstained_fields.join("; "),
    source_url: record.source_documents[0]?.url ?? "",
  };
  return CSV_COLUMNS.map((column) => csvCell(cells[column])).join(",");
}

/** A readable rendering for a terminal or a repository. */
export function renderMarkdown(record: KaRecord): string {
  const parliament = parliamentByKey(record.parliament);
  const lines: string[] = [];
  lines.push(`# ${record.title || "(no title)"}`, "");
  lines.push(`**${parliament?.label ?? record.parliament}** · Drucksache ${record.reference} · WP ${record.legislative_period}`);
  const askers = record.askers
    .map((asker) => (asker.party === undefined ? asker.name : `${asker.name} (${asker.party})`))
    .join(", ");
  if (askers !== "") lines.push(`Gefragt von: ${askers}`);
  if (record.answered_by.ministry !== undefined) lines.push(`Beantwortet von: ${record.answered_by.ministry}`);
  const dates = [
    record.dates.submitted === undefined ? undefined : `eingereicht ${record.dates.submitted}`,
    record.dates.answered === undefined ? undefined : `beantwortet ${record.dates.answered}`,
  ].filter(Boolean);
  if (dates.length > 0) lines.push(dates.join(" · "));
  lines.push("");

  if (record.markers.classified) lines.push("> **Als Verschlusssache gekennzeichnet.**", "");
  if (record.markers.attachments_referenced.length > 0) {
    lines.push(`> Anlagen: ${record.markers.attachments_referenced.join(", ")}`, "");
  }

  if (record.qa.length === 0) {
    lines.push("_No question/answer pairs were extracted from this document._", "");
  }
  for (const pair of record.qa) {
    lines.push(`## Frage ${pair.number}`, "");
    lines.push(pair.question ?? "_(abstained: the extractor did not recognise the question text)_", "");
    lines.push(`### Antwort ${pair.number}`, "");
    lines.push(pair.answer ?? "_(abstained: the extractor did not recognise the answer text)_", "");
  }

  lines.push("---", "");
  lines.push("## Provenance", "");
  lines.push(`- tier: \`${record.extraction.tier}\``);
  lines.push(`- extractor: \`${record.extraction.extractor_version}\``);
  lines.push(`- input sha256: \`${record.extraction.input_sha256}\``);
  for (const artifact of record.extraction.model_artifacts) {
    lines.push(`- model: \`${artifact.name}\` \`${artifact.version}\`${artifact.weights_sha256 ? ` (\`${artifact.weights_sha256}\`)` : ""}`);
  }
  lines.push(`- review status: \`${record.extraction.review_status}\``);
  if (record.extraction.abstained_fields.length > 0) {
    lines.push(`- abstained fields: ${record.extraction.abstained_fields.map((field) => `\`${field}\``).join(", ")}`);
  }
  for (const source of record.source_documents) {
    lines.push(`- source (${source.role}): ${source.url}${source.url_stable ? "" : " _(link expires upstream)_"}`);
  }
  return lines.join("\n") + "\n";
}

/** A plain-text rendering: the full text if there is one, else the Q/A pairs. */
export function renderText(record: KaRecord): string {
  if (record.full_text !== undefined && record.full_text !== "") return record.full_text + "\n";
  return (
    record.qa
      .map((pair) => `Frage ${pair.number}:\n${pair.question ?? "(abstained)"}\n\nAntwort zu ${pair.number}:\n${pair.answer ?? "(abstained)"}`)
      .join("\n\n") + "\n"
  );
}

export function renderRecord(record: KaRecord, format: RenderFormat): string {
  switch (format) {
    case "json":
      return renderJson(record);
    case "jsonld":
      return renderJsonLd(record);
    case "csv":
      return `${csvHeader()}\n${renderCsvRow(record)}\n`;
    case "md":
      return renderMarkdown(record);
    case "text":
      return renderText(record);
    default:
      return canonicalJson(record) + "\n";
  }
}

const XML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };

export function escapeXml(value: string): string {
  // Control characters are not representable in XML 1.0 at all; dropping them
  // keeps the feed well-formed rather than emitting a document no reader accepts.
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/[&<>"']/g, (ch) => XML_ESCAPES[ch] as string);
}

export interface FeedOptions {
  title: string;
  /** Self link of the feed. */
  id: string;
  /** ISO instant used as the feed's `updated`; injected so output is reproducible. */
  updated: string;
  /** Base for entry links when a record has no source document. */
  siteUrl?: string;
}

/**
 * The instant an entry claims it was last updated.
 *
 * A dated paper uses its own date. An undated one must not fall back to "now":
 * that value changes on every regeneration, so the entry looks freshly updated
 * each time the feed is built and every subscriber is re-notified forever. It
 * falls back instead to when the bytes were archived, which is recorded in the
 * record and therefore stable. `fallback` is the last resort for a record that
 * carries neither.
 */
export function atomEntryUpdated(record: KaRecord, fallback: string): string {
  const dated = record.dates.answered ?? record.dates.submitted;
  if (dated !== undefined) return `${dated}T00:00:00Z`;
  const retrieved = record.source_documents
    .map((document) => document.retrieved_at)
    .filter((value): value is string => value !== undefined)
    .sort();
  return retrieved[retrieved.length - 1] ?? fallback;
}

/**
 * The `<author>` elements of one entry.
 *
 * RFC 4287 §4.1.2 requires every entry to carry an author unless the feed does,
 * and this feed spans parliaments so it has no single one. The askers are the
 * authors when we know them — but `askers` is a field the extractor can abstain
 * on, and an entry with no author is not merely untidy, it makes the whole feed
 * invalid. So an entry with no known asker names the body that published the
 * paper, which is a fact we hold rather than a person we invented.
 */
function atomAuthors(record: KaRecord): string[] {
  if (record.askers.length > 0) {
    return record.askers.map((asker) => `    <author><name>${escapeXml(asker.name)}</name></author>`);
  }
  const publisher = parliamentByKey(record.parliament)?.label ?? record.parliament;
  return [`    <author><name>${escapeXml(publisher)}</name></author>`];
}

/** An Atom 1.0 feed of records, newest first. */
export function renderAtom(records: KaRecord[], options: FeedOptions): string {
  const entries = records.map((record) => {
    const link = record.source_documents[0]?.url ?? options.siteUrl ?? options.id;
    const updated = atomEntryUpdated(record, options.updated);
    const summary = [
      record.answered_by.ministry === undefined ? undefined : `Beantwortet von ${record.answered_by.ministry}.`,
      `${record.qa.length} Frage(n).`,
      record.extraction.abstained_fields.length > 0
        ? `Unvollständig extrahiert: ${record.extraction.abstained_fields.join(", ")}.`
        : undefined,
    ]
      .filter(Boolean)
      .join(" ");
    return [
      "  <entry>",
      `    <id>urn:openka:${escapeXml(record.id)}</id>`,
      `    <title>${escapeXml(record.title || record.reference)}</title>`,
      `    <link rel="alternate" href="${escapeXml(link)}"/>`,
      `    <updated>${escapeXml(updated)}</updated>`,
      ...atomAuthors(record),
      `    <category term="${escapeXml(record.parliament)}"/>`,
      `    <summary>${escapeXml(summary)}</summary>`,
      "  </entry>",
    ].join("\n");
  });

  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    `  <id>${escapeXml(options.id)}</id>`,
    `  <title>${escapeXml(options.title)}</title>`,
    `  <updated>${escapeXml(options.updated)}</updated>`,
    `  <link rel="self" href="${escapeXml(options.id)}"/>`,
    "  <generator>openka</generator>",
    ...entries,
    "</feed>",
    "",
  ].join("\n");
}
