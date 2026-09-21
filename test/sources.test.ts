// The source clients, driven against the recorded payloads in `fixtures/payloads/`.
// Tests never touch a live parliament — that is a project rule, and these fixtures
// are what make it possible to keep it.

import { deepStrictEqual, match, ok, rejects, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { childText, decodeEntities, parseXml, parseXmlFragment, streamElements } from "../src/sources/xml.js";
import { blocksWithClass, decodeHtml, firstHref, regionWithClass, spanTexts, textOf } from "../src/sources/html.js";
import { pardokVorgangToRef, parsePardokExport } from "../src/sources/pardok.js";
import { BerlinSource, berlinFeedUrl, BERLIN_LATEST_PERIOD } from "../src/sources/berlin.js";
import { BundDipSource, askersOf, parseDipAuthor, toRef } from "../src/sources/bund.js";
import { ParlamentsspiegelSource, documentRole, parseVorgangBlock, toGermanDate } from "../src/sources/parlamentsspiegel.js";
import { SOURCE_REGISTRY, createSource, sourceEntry, sourceKeys } from "../src/sources/registry.js";
import { applyWindow } from "../src/sources/base.js";
import { PARLIAMENTS } from "../src/core/models/parliaments.js";
import { MemoryStore, readFixtureText, scriptedTransport, testEngine } from "./helpers.js";

describe("XML reader", () => {
  it("parses elements, attributes and text", () => {
    const node = parseXml('<a x="1"><b>hi</b></a>');
    strictEqual(node.name, "a");
    strictEqual(node.attributes["x"], "1");
    strictEqual(childText(node, "b"), "hi");
  });

  it("resolves the predefined and numeric entities and leaves unknown ones alone", () => {
    strictEqual(decodeEntities("a &amp; b &#65; &#x42; &unknown;"), "a & b A B &unknown;");
  });

  it("skips comments, processing instructions and a DOCTYPE with an internal subset", () => {
    const nodes = parseXmlFragment('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY y "z">]><!-- c --><r>ok</r>');
    strictEqual(nodes.length, 1);
    strictEqual(nodes[0]?.text, "ok");
  });

  it("reads CDATA as text", () => {
    strictEqual(parseXml("<a><![CDATA[<raw> & stuff]]></a>").text, "<raw> & stuff");
  });

  it("streams sibling elements out of a large document", () => {
    const found = [...streamElements("<r><V><n>1</n></V><V><n>2</n></V></r>", "V")];
    deepStrictEqual(found.map((node) => childText(node, "n")), ["1", "2"]);
  });

  it("ignores a stray closing tag instead of throwing away the document", () => {
    strictEqual(childText(parseXml("<a></b><c>ok</c></a>"), "c"), "ok");
  });
});

describe("Parlamentsspiegel export format", () => {
  const xml = readFixtureText("payloads", "pardok-sample.xml");

  it("turns a Schriftliche Anfrage into a DocRef", () => {
    const refs = [...parsePardokExport(xml, { herkunft: "BLN" })];
    ok(refs.length >= 1);
    const ref = refs[0];
    match(ref?.reference ?? "", /^19\/\d+$/);
    strictEqual(ref?.legislative_period, 19);
    strictEqual(ref?.documentType, "schriftliche_anfrage");
    ok((ref?.askers.length ?? 0) >= 1);
    ok(ref?.dates.submitted !== undefined);
  });

  it("emits one combined_pdf when question and answer share a URL", () => {
    const [ref] = [...parsePardokExport(xml, { herkunft: "BLN" })];
    deepStrictEqual(ref?.documents.map((document) => document.role), ["combined_pdf"]);
  });

  it("honours a deletion marker", () => {
    const deleted = `<Vorgang><VID>V-1</VID><VFunktion>delete</VFunktion>
      <Dokument><DokTyp>SchrAnfr</DokTyp><DokNr>19/1</DokNr><Wp>19</Wp></Dokument></Vorgang>`;
    strictEqual(pardokVorgangToRef(parseXml(deleted)), undefined);
  });

  it("skips a Vorgang that is not an Anfrage", () => {
    const other = `<Vorgang><VID>V-2</VID>
      <Dokument><DokTyp>VO</DokTyp><DokNr>19/2</DokNr><Wp>19</Wp></Dokument></Vorgang>`;
    strictEqual(pardokVorgangToRef(parseXml(other)), undefined);
  });

  it("filters by Herkunft so an aggregated feed yields one Land", () => {
    strictEqual([...parsePardokExport(xml, { herkunft: "XX" })].length, 0);
  });
});

describe("Berlin source", () => {
  const xml = readFixtureText("payloads", "pardok-sample.xml");

  it("builds the open-data URL for a Wahlperiode", () => {
    strictEqual(berlinFeedUrl(19), "https://www.parlament-berlin.de/opendata/pardok-wp19.xml");
  });

  it("discovers Anfragen and records the cache validators", async () => {
    const { transport } = scriptedTransport([
      { match: "pardok-wp19.xml", body: xml, headers: { etag: '"abc"', "last-modified": "Mon, 21 Sep 2026 12:00:00 GMT" } },
    ]);
    const result = await new BerlinSource().discover({
      engine: testEngine(transport),
      state: { source: "berlin", http_cache: {} },
    });
    ok(result.refs.length >= 1);
    const cached = result.state?.http_cache[berlinFeedUrl(BERLIN_LATEST_PERIOD)];
    strictEqual(cached?.etag, '"abc"');
  });

  it("reports an unchanged feed without re-parsing it", async () => {
    const { transport, requests } = scriptedTransport([{ match: "pardok-wp19.xml", status: 304 }]);
    const result = await new BerlinSource().discover({
      engine: testEngine(transport),
      state: { source: "berlin", http_cache: { [berlinFeedUrl(19)]: { etag: '"abc"' } } },
    });
    strictEqual(result.unchanged, true);
    deepStrictEqual(result.refs, []);
    strictEqual(requests[0]?.headers?.["if-none-match"], '"abc"');
  });

  it("re-reads the feed when the caller forces it", async () => {
    const { transport, requests } = scriptedTransport([{ match: "pardok-wp19.xml", body: xml }]);
    await new BerlinSource().discover({
      engine: testEngine(transport),
      state: { source: "berlin", http_cache: { [berlinFeedUrl(19)]: { etag: '"abc"' } } },
      force: true,
    });
    strictEqual(requests[0]?.headers?.["if-none-match"], undefined);
  });

  it("refuses a Wahlperiode the feed does not cover", async () => {
    const { transport } = scriptedTransport([{ match: "pardok", body: xml }]);
    await rejects(
      () => new BerlinSource().discover({ engine: testEngine(transport), state: { source: "berlin", http_cache: {} }, period: 42 }),
      /covers Wahlperioden/,
    );
  });

  it("refuses a response that is not an export rather than reporting zero results", async () => {
    const { transport } = scriptedTransport([{ match: "pardok", body: "<html>Wartungsarbeiten</html>" }]);
    await rejects(
      () => new BerlinSource().discover({ engine: testEngine(transport), state: { source: "berlin", http_cache: {} } }),
      /did not return a Parlamentsspiegel export/,
    );
  });
});

describe("Bundestag DIP source", () => {
  const payload = readFixtureText("payloads", "dip-vorgangsposition.json");

  it("parses an author display string", () => {
    deepStrictEqual(parseDipAuthor("Dr. Alaa Alhamwi, MdB, BÜNDNIS 90/DIE GRÜNEN"), {
      name: "Dr. Alaa Alhamwi",
      role: "MdB",
      party: "BÜNDNIS 90/DIE GRÜNEN",
    });
  });

  it("records a Fraktion as the asker when no individuals are named", () => {
    const askers = askersOf({ urheber: [{ bezeichnung: "AfD", titel: "Fraktion der AfD" }] });
    deepStrictEqual(askers, [{ name: "Fraktion der AfD", role: "Fraktion", party: "AfD" }]);
  });

  it("assembles a DocRef from the two positions of a Vorgang", () => {
    const positions = (JSON.parse(payload) as { documents: Record<string, unknown>[] }).documents;
    const warnings: string[] = [];
    const ref = toRef("338265", positions, warnings);
    strictEqual(ref?.reference, "21/7563");
    strictEqual(ref?.legislative_period, 21);
    strictEqual(ref?.documentType, "kleine_anfrage");
    strictEqual(ref?.dates.submitted, "2026-08-13");
    strictEqual(ref?.dates.answered, "2026-09-10");
    match(ref?.answered_by.ministry ?? "", /Bundesministerium/);
    deepStrictEqual(ref?.documents.map((document) => document.role), ["question_pdf", "answer_pdf"]);
    deepStrictEqual(warnings, []);
  });

  it("skips a Vorgang whose question position is missing, and says so", () => {
    const warnings: string[] = [];
    strictEqual(toRef("1", [{ vorgangsposition: "Antwort" }], warnings), undefined);
    ok(warnings[0]?.includes("no \"Kleine Anfrage\" position"));
  });

  it("refuses to run without an API key", async () => {
    const { transport } = scriptedTransport([{ match: "dip", body: "{}" }]);
    await rejects(
      () => new BundDipSource().discover({ engine: testEngine(transport), state: { source: "bund", http_cache: {} } }),
      /needs a key/,
    );
  });

  it("sends the key and walks the cursor to the end", async () => {
    let page = 0;
    const engine = testEngine(async (request) => {
      page++;
      const documents = page === 1 ? (JSON.parse(payload) as { documents: unknown[] }).documents : [];
      return {
        status: 200,
        headers: {},
        body: Buffer.from(JSON.stringify({ numFound: 2, documents, cursor: page === 1 ? "next" : "next" })),
      };
      void request;
    });
    const result = await new BundDipSource().discover({
      engine,
      state: { source: "bund", http_cache: {} },
      apiKey: "test-key",
    });
    strictEqual(result.refs.length, 1);
    strictEqual(result.refs[0]?.reference, "21/7563");
  });
});

describe("Parlamentsspiegel source", () => {
  const html = readFixtureText("payloads", "parlamentsspiegel-results.html");

  it("converts an ISO date to the form the search form wants", () => {
    strictEqual(toGermanDate("2024-03-01"), "01.03.2024");
  });

  it("parses a result block into a DocRef with its own parliament", () => {
    const blocks = blocksWithClass(html, "ps-vorgang", /<hr\s*\/?>/);
    ok(blocks.length >= 1);
    const warnings: string[] = [];
    const ref = parseVorgangBlock(blocks[0] as string, warnings);
    strictEqual(ref?.parliament, "nordrhein-westfalen");
    match(ref?.reference ?? "", /^\d{2}\/\d+$/);
    strictEqual(ref?.documentType, "kleine_anfrage");
    ok((ref?.title.length ?? 0) > 10);
    ok(ref?.documents.some((document) => document.role === "question_pdf"));
  });

  it("picks up the Antwort from the follow-up documents", () => {
    const blocks = blocksWithClass(html, "ps-vorgang", /<hr\s*\/?>/);
    const refs = blocks.map((block) => parseVorgangBlock(block, [])).filter(Boolean);
    const answered = refs.find((ref) => ref?.documents.some((document) => document.role === "answer_pdf"));
    ok(answered !== undefined, "expected at least one result with an answer document");
    ok(answered?.dates.answered !== undefined);
    ok(answered?.answered_by.ministry !== undefined);
  });

  it("accepts the word Thüringen uses for a paper", () => {
    // Most Länder label it "Drucksache"; Thüringen labels the same thing
    // "Dokument", and requiring the commoner word cost that Land every record.
    const row = (label: string): string =>
      `<div class="ps-vorgang"><p class="ps-titel"><a class="ps-details" href=".ps-detail-THUE_V1_D2"><span>T</span></a></p>` +
      `<p class="ps-dokument"><div><a href="https://example.invalid/a.pdf"><span>${label} 08/3102</span></a>` +
      `<span>Thüringen - Kleine Anfrage; AfD; 09.09.2026; (2 S.)</span></div></p></div>`;
    strictEqual(parseVorgangBlock(row("Drucksache"), [])?.reference, "08/3102");
    strictEqual(parseVorgangBlock(row("Dokument"), [])?.reference, "08/3102");
  });

  it("reports rather than guesses when the markup yields nothing", async () => {
    const { transport } = scriptedTransport([{ match: "/suche", body: "<html><body>redesigned</body></html>" }]);
    const result = await new ParlamentsspiegelSource().discover({
      engine: testEngine(transport),
      state: { source: "parlamentsspiegel", http_cache: {} },
    });
    deepStrictEqual(result.refs, []);
    ok(result.warnings[0]?.includes("markup changed"));
  });

  it("pins itself to one Land's Herkunft code when constructed with a parliament", async () => {
    const { transport, requests } = scriptedTransport([{ match: "/suche", body: html }]);
    await new ParlamentsspiegelSource("hamburg").discover({
      engine: testEngine(transport),
      state: { source: "x", http_cache: {} },
      limit: 1,
    });
    match(requests[0]?.url ?? "", /qyHerk=HH/);
  });
});

describe("document roles in a result row", () => {
  it("reads a combined paper from the Fundstelle", () => {
    // Schleswig-Holstein files the Vorgang under "Antwort" but publishes the Kleine
    // Anfrage and the reply as one Drucksache; the Fundstelle is what says so.
    strictEqual(
      documentRole(
        "Drucksache 20/3331 : Schleswig-Holstein - Antwort; Abgeordnete/r: SPD, Landesregierung; 26.06.2025",
        "Schleswig-Holstein - Kleine Anfrage Birte Pauls (SPD) und Antwort MSJFSIG 26.06.2025 Drucksache 20/3331",
      ),
      "combined_pdf",
    );
  });

  it("reads a question row as a question", () => {
    strictEqual(
      documentRole("Nordrhein-Westfalen - Kleine Anfrage; Abgeordnete/r: FDP; 17.09.2026", "… Kleine Anfrage 8783 …"),
      "question_pdf",
    );
  });

  it("reads an answer-only row as an answer", () => {
    strictEqual(documentRole("Brandenburg - Antwort (Ministerium des Innern) 18.07.2025", "Brandenburg - Antwort …"), "answer_pdf");
  });

  it("parses Schleswig-Holstein rows as combined documents dated by the answer", () => {
    const html = readFixtureText("payloads", "parlamentsspiegel-sh.html");
    const blocks = blocksWithClass(html, "ps-vorgang", /<hr\s*\/?>/);
    ok(blocks.length >= 1);
    for (const block of blocks) {
      const ref = parseVorgangBlock(block, []);
      strictEqual(ref?.parliament, "schleswig-holstein");
      deepStrictEqual(ref?.documents.map((document) => document.role), ["combined_pdf"]);
      // The one printed date is when the combined paper appeared. The question's own
      // date is not in the row, and a guessed one would be worse than none.
      ok(ref?.dates.answered !== undefined);
      strictEqual(ref?.dates.submitted, undefined);
    }
  });
});

describe("HTML helpers", () => {
  it("decodes entities and strips tags", () => {
    strictEqual(textOf("<p>Br&uuml;cke <b>&amp;</b> Weg</p>"), "Brücke & Weg");
    strictEqual(decodeHtml("&#8211;"), "–");
  });

  it("matches a class as a whole word", () => {
    const html = '<div class="ps-folge-dok">a</div><div class="ps-folge bg">b</div>';
    strictEqual(blocksWithClass(html, "ps-folge").length, 1);
  });

  it("reads a region, its spans and its first link", () => {
    const html = '<p class="ps-titel"><a href="/x"><span>Titel</span></a></p>';
    const region = regionWithClass(html, "ps-titel");
    deepStrictEqual(spanTexts(region ?? ""), ["Titel"]);
    strictEqual(firstHref(region ?? ""), "/x");
  });
});

describe("source registry", () => {
  it("registers all 17 parliaments plus the aggregator", () => {
    const parliaments = new Set(SOURCE_REGISTRY.map((entry) => entry.parliament));
    strictEqual(parliaments.size, PARLIAMENTS.length);
    ok(sourceKeys().includes("parlamentsspiegel"));
  });

  it("marks the parliaments with no dedicated adapter honestly", () => {
    strictEqual(sourceEntry("sachsen")?.status, "via_aggregator");
    strictEqual(sourceEntry("berlin")?.status, "implemented");
  });

  it("builds a source for every registered key", () => {
    for (const key of sourceKeys()) ok(createSource(key).key.length > 0);
  });

  it("names the alternatives when a key is unknown", () => {
    let message = "";
    try {
      createSource("atlantis");
    } catch (err) {
      message = err instanceof Error ? err.message : "";
    }
    match(message, /Known sources:/);
  });
});

describe("discovery windows", () => {
  const refs = [
    { key: "b", reference: "19/2", legislative_period: 19, title: "", documentType: "kleine_anfrage" as const, askers: [], answered_by: {}, dates: { answered: "2024-06-01" }, documents: [] },
    { key: "a", reference: "19/1", legislative_period: 19, title: "", documentType: "kleine_anfrage" as const, askers: [], answered_by: {}, dates: { answered: "2024-01-01" }, documents: [] },
    { key: "c", reference: "20/3", legislative_period: 20, title: "", documentType: "kleine_anfrage" as const, askers: [], answered_by: {}, dates: { answered: "2025-01-01" }, documents: [] },
  ];
  const engine = testEngine(async () => ({ status: 200, headers: {}, body: Buffer.alloc(0) }));
  const base = { engine, state: { source: "x", http_cache: {} } };

  it("filters by date and sorts by key for a stable order", () => {
    deepStrictEqual(applyWindow(refs, { ...base, since: "2024-01-01", until: "2024-12-31" }).map((ref) => ref.key), ["a", "b"]);
  });

  it("filters by legislative period", () => {
    deepStrictEqual(applyWindow(refs, { ...base, period: 20 }).map((ref) => ref.key), ["c"]);
  });

  it("applies the limit after sorting", () => {
    deepStrictEqual(applyWindow(refs, { ...base, limit: 1 }).map((ref) => ref.key), ["a"]);
  });
});

describe("the memory store used by these tests", () => {
  it("behaves like the real one for blobs and records", () => {
    const store = new MemoryStore();
    const digest = store.putBlob(Buffer.from("x"));
    ok(store.hasBlob(digest));
    strictEqual(store.recordIds().length, 0);
  });
});
