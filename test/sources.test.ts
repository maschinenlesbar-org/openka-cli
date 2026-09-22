// The source clients, driven against the recorded payloads in `fixtures/payloads/`.
// Tests never touch a live parliament — that is a project rule, and these fixtures
// are what make it possible to keep it.

import { deepStrictEqual, match, ok, rejects, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { childText, decodeEntities, parseXml, parseXmlFragment, streamElements } from "../src/sources/xml.js";
import { blocksWithClass, decodeHtml, firstHref, regionWithClass, spanTexts, textOf, visibleTextOf } from "../src/sources/html.js";
import { pardokVorgangToRef, parsePardokExport } from "../src/sources/pardok.js";
import { BerlinSource, berlinFeedUrl, BERLIN_LATEST_PERIOD } from "../src/sources/berlin.js";
import { BundDipSource, askersOf, parseDipAuthor, toRef } from "../src/sources/bund.js";
import { ParlamentsspiegelSource, documentRole, parseVorgangBlock, toGermanDate, ParlamentsspiegelAllLaender } from "../src/sources/parlamentsspiegel.js";
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

  it("refuses a character reference that would produce a lone surrogate", () => {
    // Not a character: it cannot be written to XML and becomes U+FFFD as soon as
    // the string is encoded, so a feed built from it stops matching its record.
    strictEqual(decodeEntities("&#xD800;"), "&#xD800;");
    strictEqual(decodeEntities("&#55296;"), "&#55296;");
    strictEqual(decodeEntities("&#xE4;"), "ä");
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

  it("does not swallow the record after a self-closing element", () => {
    // `<V/>` has no `</V>`, so taking the next one consumed the element after it
    // and dropped that record entirely — silent loss in a 30k-record export.
    const found = [...streamElements("<r><V><n>1</n></V><V/><V><n>3</n></V><V><n>4</n></V></r>", "V")];
    deepStrictEqual(found.map((node) => childText(node, "n")), ["1", undefined, "3", "4"]);
  });

  it("keeps streaming when a self-closing element is the last one", () => {
    const found = [...streamElements("<r><V><n>1</n></V><V/></r>", "V")];
    strictEqual(found.length, 2);
  });

  it("ignores a stray closing tag instead of throwing away the document", () => {
    strictEqual(childText(parseXml("<a></b><c>ok</c></a>"), "c"), "ok");
  });
});

describe("source registry", () => {
  it("gives every adapter the key the registry lists it under", () => {
    // The pipeline persists sync state under `source.key`; `ka sources list` and
    // the health report read it back by the registry key. When they disagreed,
    // every aggregator-backed Land reported "never synced" right after a sync.
    for (const entry of SOURCE_REGISTRY) {
      if (entry.factory === undefined) continue;
      strictEqual(createSource(entry.key).key, entry.key, `adapter key differs for ${entry.key}`);
    }
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

  it("namespaces the discovery key by the field it came from", () => {
    const doc = `<Dokument><DokTyp>SchrAnfr</DokTyp><DokNr>19/1234</DokNr><Wp>19</Wp></Dokument>`;
    const keyOf = (head: string): string | undefined =>
      pardokVorgangToRef(parseXml(`<Vorgang>${head}${doc}</Vorgang>`))?.key;

    strictEqual(keyOf("<VID>1234</VID><VNr>7</VNr>"), "VID:1234");
    strictEqual(keyOf("<VNr>1234</VNr>"), "VNr:1234");
    strictEqual(keyOf(""), "ref:19/1234");
    // Unprefixed these three were the same string, so a Vorgang identified by its
    // VNr shadowed an unrelated one whose VID happened to carry the same digits.
    strictEqual(new Set([keyOf("<VID>1234</VID>"), keyOf("<VNr>1234</VNr>"), keyOf("")]).size, 3);
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

  it("does not name a ministry DIP did not mark as the lead", () => {
    // The array order is an accident of the API. Taking the first entry published
    // a positional accident as a fact about who answered; for the Bundestag the
    // PDF cannot rescue it either, since an answer never names the ministry in
    // its text. A named hole beats a plausible wrong ministry.
    const answer = (ressort: unknown[]) => [
      {
        vorgangsposition: "Kleine Anfrage",
        dokumentart: "Drucksache",
        fundstelle: { dokumentnummer: "21/7449", pdf_url: "https://x.invalid/q.pdf", datum: "2026-08-13" },
        titel: "T",
      },
      {
        vorgangsposition: "Antwort",
        dokumentart: "Drucksache",
        fundstelle: { pdf_url: "https://x.invalid/a.pdf", datum: "2026-08-17" },
        ressort,
      },
    ];
    const ministryOf = (ressort: unknown[], warnings: string[] = []) =>
      toRef("1", answer(ressort) as never, warnings)?.answered_by.ministry;

    // One ressort: nothing to choose between, flag or no flag.
    strictEqual(ministryOf([{ titel: "BMBFSFJ" }]), "BMBFSFJ");
    // Several, one marked: the marked one.
    strictEqual(ministryOf([{ titel: "BMF" }, { titel: "BMVg", federfuehrend: true }]), "BMVg");
    // Several, none marked: no ministry, and the run says so.
    const warnings: string[] = [];
    strictEqual(ministryOf([{ titel: "BMF" }, { titel: "BMVg" }], warnings), undefined);
    match(warnings[0] ?? "", /none marked federfuehrend/);
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

  it("reads a follow-up the portal did not collapse", () => {
    // The portal only puts the `ps-folge` class on the wrapper when the search
    // filtered some of a Vorgang's follow-ups away. A row reading
    // "0 gefiltert/ausgeblendet" renders the same markup under a bare `<div >`,
    // and splitting on `ps-folge` lost its answer entirely — which is every
    // Niedersachsen and Thüringen row in the recorded payloads.
    for (const payload of ["parlamentsspiegel-niedersachsen.html", "parlamentsspiegel-thueringen.html"]) {
      const blocks = blocksWithClass(readFixtureText("payloads", payload), "ps-vorgang", /<hr\s*\/?>/);
      const refs = blocks.map((block) => parseVorgangBlock(block, []));
      ok(refs.length >= 1);
      for (const ref of refs) {
        ok(ref?.documents.some((document) => document.role === "answer_pdf"), `${payload}: no answer document`);
        ok(ref?.dates.answered !== undefined, `${payload}: no answer date`);
        ok(ref?.answered_by.ministry !== undefined, `${payload}: no answering body`);
      }
    }
  });

  it("takes the answering body from the follow-up's own Urheber field", () => {
    const ministryOf = (payload: string): (string | undefined)[] =>
      blocksWithClass(readFixtureText("payloads", payload), "ps-vorgang", /<hr\s*\/?>/)
        .map((block) => parseVorgangBlock(block, [])?.answered_by.ministry);

    // Reading it out of the summary line instead meant guessing where the name
    // began. Thüringen writes "Antwort auf Kleine Anfrage. Ministerium für …",
    // whose leading clause is not part of the name, and Sachsen writes
    // "Antw SMI 12.08.2025 Drs 8/3351", which has no delimiter to stop at.
    deepStrictEqual(ministryOf("parlamentsspiegel-sachsen.html"), ["SMI", "SMI"]);
    for (const ministry of ministryOf("parlamentsspiegel-thueringen.html")) {
      match(ministry ?? "", /^Ministerium für /);
    }
    // Unchanged where the old reading already worked.
    deepStrictEqual(ministryOf("parlamentsspiegel-saarland.html"), ["Landesregierung", "Landesregierung"]);
    deepStrictEqual(ministryOf("parlamentsspiegel-nrw.html"), ["MUNV", "MUNV", "MUNV"]);
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
    const result = await new ParlamentsspiegelAllLaender().discover({
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
    // A surrogate code point is not a character; the reference is left as written.
    strictEqual(decodeHtml("&#xD800;"), "&#xD800;");
  });

  it("strips every hidden element, not just the first hundred", () => {
    // The guard used to stop at 100 and return half-stripped markup, leaking the
    // hidden "Neuestes Dokument" date this function exists to remove.
    const row = (i: number) =>
      `<div class="ps-folge"><span>S ${i}</span><span class="d-none"><span>Neuestes Dokument: 2025-01-01</span></span></div>`;
    const text = visibleTextOf(Array.from({ length: 150 }, (_, i) => row(i)).join(""));
    strictEqual(text.includes("Neuestes Dokument"), false);
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
    // Counted on entries that name a parliament. This used to count the whole
    // registry and still come to 17, because the aggregator's placeholder
    // `parliament` collided with the Land it was borrowed from — the test was
    // relying on the very confusion that put a Land's record count under the
    // aggregator's row.
    const named = new Set(SOURCE_REGISTRY.map((entry) => entry.parliament).filter((key) => key !== undefined));
    strictEqual(named.size, PARLIAMENTS.length);
    ok(sourceKeys().includes("parlamentsspiegel"));
  });

  it("gives the all-Länder adapter no parliament of its own", () => {
    strictEqual(sourceEntry("parlamentsspiegel")?.parliament, undefined);
    strictEqual(createSource("parlamentsspiegel").parliament, undefined);
    // A Land-pinned instance still names one.
    strictEqual(createSource("hamburg").parliament, "hamburg");
  });

  it("marks the parliaments with no dedicated adapter honestly", () => {
    // Niedersachsen's answer is the one the Parlamentsspiegel still will not render
    // and no other route has been found for, so the aggregator is all it has.
    // Hessen, Brandenburg, MV and the rest still reach their answers through the
    // aggregator, which renders their follow-up documents.
    strictEqual(sourceEntry("hessen")?.status, "via_aggregator");
    strictEqual(sourceEntry("brandenburg")?.status, "via_aggregator");
    strictEqual(sourceEntry("thueringen")?.status, "implemented");
    strictEqual(sourceEntry("niedersachsen")?.status, "implemented");
    strictEqual(sourceEntry("berlin")?.status, "implemented");
    strictEqual(sourceEntry("sachsen")?.status, "implemented");
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
