// The output renderings. The rule every one of them has to follow: an abstained
// field is visibly absent, never an empty value that reads like "nothing there".

import { doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CSV_COLUMNS,
  csvCell,
  csvHeader,
  escapeXml,
  renderAtom,
  renderCsvRow,
  renderJson,
  renderJsonLd,
  renderMarkdown,
  renderRecord,
  renderText,
} from "../src/core/render/render.js";
import { canonicalJsonLine } from "../src/core/repro/canonical.js";
import { sampleRecord } from "./helpers.js";

const incomplete = sampleRecord({
  qa: [{ number: "1", question: "Wie viele Brücken sind marode?" }],
  extraction: {
    ...sampleRecord().extraction,
    parse_complete: false,
    abstained_fields: ["qa[0].answer"],
    review_status: "needs_review",
  },
});

describe("JSON", () => {
  it("is the canonical form, so the file, the hash and the output agree", () => {
    strictEqual(renderJson(sampleRecord()), canonicalJsonLine(sampleRecord()));
  });
});

describe("JSON-LD", () => {
  it("uses schema.org terms and keeps the provenance under its own namespace", () => {
    const parsed = JSON.parse(renderJsonLd(sampleRecord())) as Record<string, unknown>;
    strictEqual(parsed["@type"], "Legislation");
    strictEqual(parsed["identifier"], "19/12345");
    ok(parsed["openka:extraction"] !== undefined);
    ok(Array.isArray(parsed["author"]));
  });

  it("omits an abstained answer instead of emitting an empty one", () => {
    const parsed = JSON.parse(renderJsonLd(incomplete)) as { "openka:qa": Record<string, unknown>[] };
    strictEqual(parsed["openka:qa"][0]?.["acceptedAnswer"], undefined);
  });
});

describe("CSV", () => {
  it("quotes every cell and doubles embedded quotes", () => {
    strictEqual(csvCell('a "b", c'), '"a ""b"", c"');
  });

  it("neutralises a cell a spreadsheet would run as a formula", () => {
    strictEqual(csvCell('=HYPERLINK("http://evil","click")'), `"'=HYPERLINK(""http://evil"",""click"")"`);
    strictEqual(csvCell("=cmd|'/c calc'!A1"), `"'=cmd|'/c calc'!A1"`);
    for (const lead of ["+", "-", "@"]) strictEqual(csvCell(`${lead}x`).startsWith(`"'${lead}`), true);
    // Ordinary text is untouched — the apostrophe is not sprinkled on everything.
    strictEqual(csvCell("Brücken im Bund"), '"Brücken im Bund"');
  });

  it("has a header matching its columns", () => {
    strictEqual(csvHeader().split(",").length, CSV_COLUMNS.length);
    strictEqual(renderCsvRow(sampleRecord()).split('","').length, CSV_COLUMNS.length);
  });

  it("carries the abstained fields in their own column", () => {
    match(renderCsvRow(incomplete), /"qa\[0\]\.answer"/);
  });

  it("survives a title containing a comma, a quote and a newline", () => {
    const row = renderCsvRow(sampleRecord({ title: 'Brücken, "marode"\nund alt' }));
    match(row, /"Brücken, ""marode""\nund alt"/);
  });
});

describe("Markdown", () => {
  it("renders the questions and the provenance", () => {
    const text = renderMarkdown(sampleRecord());
    match(text, /^# Zustand der Brückenbauwerke/);
    match(text, /## Frage 1/);
    match(text, /- tier: `text_layer`/);
    match(text, /- input sha256: `1{64}`/);
  });

  it("says a field was abstained rather than leaving a blank", () => {
    const text = renderMarkdown(incomplete);
    match(text, /_\(abstained: the extractor did not recognise the answer text\)_/);
    match(text, /- abstained fields: `qa\[0\]\.answer`/);
  });

  it("flags a classified document and an expiring link", () => {
    const text = renderMarkdown(
      sampleRecord({
        markers: { classified: true, contains_tables: false, attachments_referenced: ["Anlage 1"] },
        source_documents: [{ role: "answer_pdf", url: "https://x.invalid/a.pdf", url_stable: false }],
      }),
    );
    match(text, /Als Verschlusssache gekennzeichnet/);
    match(text, /Anlagen: Anlage 1/);
    match(text, /_\(link expires upstream\)_/);
  });
});

describe("plain text", () => {
  it("prefers the full text and falls back to the pairs", () => {
    match(renderText(sampleRecord()), /^Frage 1:/);
    const noFullText = sampleRecord();
    delete noFullText.full_text;
    match(renderText(noFullText), /Antwort zu 1:/);
  });
});

describe("Atom feed", () => {
  const feed = renderAtom([sampleRecord(), incomplete], {
    title: "OpenKA",
    id: "urn:openka:test",
    updated: "2026-01-02T03:04:05Z",
  });

  it("is well-formed enough to declare itself an Atom feed", () => {
    match(feed, /^<\?xml version="1\.0" encoding="utf-8"\?>/);
    match(feed, /<feed xmlns="http:\/\/www\.w3\.org\/2005\/Atom">/);
    strictEqual(feed.match(/<entry>/g)?.length, 2);
  });

  it("dates an entry from the answer date", () => {
    match(feed, /<updated>2024-03-28T00:00:00Z<\/updated>/);
  });

  it("gives every entry an author, naming the parliament when the askers are unknown", () => {
    // `askers` is a field the extractor can abstain on, and an entry with no
    // author makes the whole feed invalid under RFC 4287 §4.1.2.
    const anonymous = renderAtom([sampleRecord({ askers: [] })], {
      title: "OpenKA",
      id: "urn:openka:test",
      updated: "2026-01-02T03:04:05Z",
    });
    strictEqual(anonymous.match(/<entry>/g)?.length, 1);
    strictEqual(anonymous.match(/<author>/g)?.length, 1);
    match(anonymous, /<author><name>Abgeordnetenhaus von Berlin<\/name><\/author>/);
  });

  it("says in the summary when a record is incomplete", () => {
    match(feed, /Unvollständig extrahiert: qa\[0\]\.answer\./);
  });

  it("escapes XML metacharacters and drops characters XML cannot carry", () => {
    strictEqual(escapeXml('a & b <c> "d"'), "a &amp; b &lt;c&gt; &quot;d&quot;");
    strictEqual(escapeXml("a\u0000b"), "ab");
  });

  it("does not leak a raw ampersand from a title", () => {
    const hostile = renderAtom([sampleRecord({ title: "Brücken & Wege <script>" })], {
      title: "t",
      id: "urn:x",
      updated: "2026-01-02T03:04:05Z",
    });
    doesNotMatch(hostile, /<title>Brücken & Wege/);
    match(hostile, /Brücken &amp; Wege &lt;script&gt;/);
  });
});

describe("format dispatch", () => {
  it("routes every declared format", () => {
    for (const format of ["json", "jsonld", "csv", "md", "text"] as const) {
      ok(renderRecord(sampleRecord(), format).length > 0);
    }
  });
});
