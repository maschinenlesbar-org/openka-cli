// Renderings of the one canonical record: JSON, JSON-LD, CSV, Markdown and Atom.
//
// Every renderer shares one rule about holes: an abstained field is rendered as
// *visibly* absent, never as an empty value that reads like "there was nothing
// there". CSV gets an explicit `abstained_fields` column, Markdown prints the
// abstentions, and the feed says so in the entry. A hole a consumer cannot see is
// the same problem as an invented value.

import { canonicalJson, canonicalJsonLine } from "@maschinenlesbar.org/openka-lib-repro";
import { assertValid, nonBlankProblem, type Problem } from "@maschinenlesbar.org/openka-lib-errors";
import type { KaRecord } from "@maschinenlesbar.org/openka-lib-models";
import { parliamentByKey } from "@maschinenlesbar.org/openka-lib-models";
import { stripControlCharacters } from "@maschinenlesbar.org/openka-lib-text";

export const RENDER_FORMATS = ["json", "jsonld", "csv", "md", "text"] as const;
export type RenderFormat = (typeof RENDER_FORMATS)[number];

/** Why `value` is not a render format, or `undefined` when it is one (exactly). */
export const renderFormatProblem: Problem<string> = (value) =>
  (RENDER_FORMATS as readonly string[]).includes(value) ? undefined : `Allowed choices are ${RENDER_FORMATS.join(", ")}.`;

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
  return canonicalJsonLine(jsonLdNode(record));
}

/**
 * Many records as JSON Lines: one compact canonical record per line, nothing else
 * on it. `ka export --format jsonl` used to join the pretty-printed on-disk form,
 * ~80 lines per record with `{` alone on the first, which `jq -s` tolerates and
 * every line-oriented reader (pandas `lines=True`, DuckDB, `split -l`) does not.
 * Keys stay sorted, so a line is the stored record minus its whitespace.
 */
export function renderJsonLines(records: readonly KaRecord[]): string {
  return records.map((record) => canonicalJson(record, 0) + "\n").join("");
}

/**
 * Many records as one JSON-LD document: a top-level array of the node objects
 * `renderJsonLd` prints, each with its own `@context` — a form JSON-LD 1.1 allows.
 * The objects used to be written back to back, which no JSON parser reads past the
 * first one.
 */
export function renderJsonLdDocument(records: readonly KaRecord[]): string {
  return canonicalJsonLine(records.map(jsonLdNode));
}

function jsonLdNode(record: KaRecord): Record<string, unknown> {
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
  return document;
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
  const clean = stripControlCharacters(value);
  const safe = CSV_FORMULA_LEAD.test(clean) ? `'${clean}` : clean;
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

/**
 * A readable rendering for a terminal or a repository.
 *
 * Human-facing renderings strip control characters; `json` and `jsonld` do not,
 * deliberately — those must stay byte-identical to what is on disk, which is what
 * `ka verify` compares.
 *
 * Nothing that goes through the store can carry one: extraction strips them and
 * `putRecord` refuses them. The strip here is for the other caller — these
 * renderers are part of the published library surface, so a consumer can hand one
 * a `KaRecord` it built itself, which never passed the store at all.
 */
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
  return stripControlCharacters(lines.join("\n")) + "\n";
}

/** A plain-text rendering: the full text if there is one, else the Q/A pairs. */
export function renderText(record: KaRecord): string {
  if (record.full_text !== undefined && record.full_text !== "") {
    return stripControlCharacters(record.full_text) + "\n";
  }
  return stripControlCharacters(
    record.qa
      .map((pair) => `Frage ${pair.number}:\n${pair.question ?? "(abstained)"}\n\nAntwort zu ${pair.number}:\n${pair.answer ?? "(abstained)"}`)
      .join("\n\n")) + "\n";
}

/**
 * Render a record in one of `RENDER_FORMATS`. Any other format throws
 * `OpenKaValidationError`: it used to fall through to JSON, so a caller passing
 * user input on got a different format with no error.
 */
export function renderRecord(record: KaRecord, format: RenderFormat): string {
  assertValid("format", format, renderFormatProblem);
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
    default: {
      const unreachable: never = format;
      return unreachable;
    }
  }
}

const XML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };

export function escapeXml(value: string): string {
  // Control characters are not representable in XML 1.0 at all; dropping them
  // keeps the feed well-formed rather than emitting a document no reader accepts.
  // DEL and the C1 block belong in that set too: they were left in, so a feed
  // could carry U+009B — the 8-bit form of CSI — straight to whatever prints it.
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
    .replace(/[&<>"']/g, (ch) => XML_ESCAPES[ch] as string);
}

/** The feed's title when `FeedOptions.title` is omitted. */
export const DEFAULT_FEED_TITLE = "OpenKA — Kleine Anfragen";
/** The feed's id and self link when `FeedOptions.id` is omitted. */
export const DEFAULT_FEED_ID = "urn:openka:feed";

export interface FeedOptions {
  /** `DEFAULT_FEED_TITLE` when omitted; a blank one is refused. */
  title?: string;
  /** Self link of the feed; `DEFAULT_FEED_ID` when omitted, a blank one is refused. */
  id?: string;
  /** ISO instant used as the feed's `updated`; injected so output is reproducible. */
  updated: string;
  /** Base for entry links when a record has no source document. */
  siteUrl?: string;
  /** At most this many entries: the newest, chosen from the whole set given. */
  limit?: number;
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

/**
 * A copy of `records`, newest first by the instant each entry will print
 * (`atomEntryUpdated`), ties broken on the id — so "newest first" is true of the
 * feed a reader sees rather than only of the dates. Plain string comparison, not
 * localeCompare: these are ISO instants, and the order of a published feed must
 * not depend on the locale of the machine that built it.
 */
export function newestFirst(records: readonly KaRecord[], fallback: string): KaRecord[] {
  return records
    .map((record) => ({ record, updated: atomEntryUpdated(record, fallback) }))
    .sort((a, b) => {
      if (a.updated !== b.updated) return a.updated < b.updated ? 1 : -1;
      return a.record.id < b.record.id ? -1 : a.record.id > b.record.id ? 1 : 0;
    })
    .map(({ record }) => record);
}

/**
 * An Atom 1.0 feed of records, newest first — whatever order they are given in,
 * and with `limit`, the newest N of the whole set.
 */
export function renderAtom(records: KaRecord[], feedOptions: FeedOptions): string {
  // A blank title or id is an invalid Atom feed, not an untitled one.
  assertValid("title", feedOptions.title, nonBlankProblem);
  assertValid("id", feedOptions.id, nonBlankProblem);
  const options = { ...feedOptions, title: feedOptions.title ?? DEFAULT_FEED_TITLE, id: feedOptions.id ?? DEFAULT_FEED_ID };
  const newest = newestFirst(records, options.updated);
  const selected = options.limit === undefined ? newest : newest.slice(0, options.limit);
  const entries = selected.map((record) => {
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
