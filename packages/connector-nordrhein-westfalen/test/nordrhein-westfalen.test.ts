// The Landtag NRW source, and the aggregator defects that kept it at zero.
//
// NRW is the case that exposed three separate bugs, so the tests that pin them down
// live together here: a hidden date in the result row, a free-text query that
// excluded whole Länder, and a date window measured against the wrong date.

import { match, ok, rejects, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  NordrheinWestfalenSource,
  NRW_ARCHIVE,
  ROBOTS_DISALLOWED_PERIODS,
  nrwDocumentUrl,
  referenceFromNrwUrl,
} from "../src/index.js";
import { stripHidden, visibleTextOf } from "@maschinenlesbar.org/openka-lib-source";
import { blocksWithClass } from "@maschinenlesbar.org/openka-lib-source";
import { parseVorgangBlock } from "@maschinenlesbar.org/openka-lib-parlamentsspiegel";
import { applyWindow, type DiscoverOptions, type DocRef } from "@maschinenlesbar.org/openka-lib-source";
import { sourceEntry } from "@maschinenlesbar.org/openka-lib-registry";
import { scriptedTransport, testEngine, fixturesOf } from "@maschinenlesbar.org/openka-lib-testing";

const { readFixtureText } = fixturesOf("@maschinenlesbar.org/openka-lib-parlamentsspiegel", import.meta.url);

const NRW_HTML = readFixtureText("payloads", "parlamentsspiegel-nrw.html");

describe("NRW document URLs", () => {
  it("builds the archive URL from a Drucksachennummer", () => {
    strictEqual(nrwDocumentUrl("18/14035"), `${NRW_ARCHIVE}/MMD18-14035.pdf`);
    strictEqual(nrwDocumentUrl("18 / 14035"), `${NRW_ARCHIVE}/MMD18-14035.pdf`);
  });

  it("declines a reference it cannot read, rather than inventing a URL", () => {
    strictEqual(nrwDocumentUrl("Drucksache 18/14035"), undefined);
    strictEqual(nrwDocumentUrl("18/14035a"), undefined);
    strictEqual(nrwDocumentUrl(""), undefined);
  });

  it("reads a Drucksachennummer back out of an archive URL", () => {
    strictEqual(referenceFromNrwUrl(`${NRW_ARCHIVE}/MMD18-14035.pdf`), "18/14035");
    strictEqual(referenceFromNrwUrl("https://example.invalid/other.pdf"), undefined);
  });

  it("round-trips", () => {
    strictEqual(referenceFromNrwUrl(nrwDocumentUrl("18/1") as string), "18/1");
  });
});

describe("NRW source", () => {
  function options(extra: Partial<DiscoverOptions> = {}): DiscoverOptions {
    const { transport } = scriptedTransport([{ match: "/suche", body: NRW_HTML }]);
    return { engine: testEngine(transport), state: { source: "nordrhein-westfalen", http_cache: {} }, ...extra };
  }

  it("is registered as an implemented source, not via the aggregator", () => {
    strictEqual(sourceEntry("nordrhein-westfalen")?.status, "implemented");
  });

  it("discovers Kleine Anfragen with canonical document URLs", async () => {
    const result = await new NordrheinWestfalenSource().discover(options());
    ok(result.refs.length >= 1);
    for (const ref of result.refs) {
      for (const document of ref.documents) {
        match(document.url, /^https:\/\/www\.landtag\.nrw\.de\/portal\/WWW\/dokumentenarchiv\/Dokument\/MMD\d+-\d+\.pdf$/);
        strictEqual(document.urlStable, true);
      }
    }
  });

  it("always addresses the question document, even from the number alone", async () => {
    const result = await new NordrheinWestfalenSource().discover(options());
    for (const ref of result.refs) {
      const question = ref.documents.find((document) => document.role === "question_pdf");
      strictEqual(question?.url, nrwDocumentUrl(ref.reference));
    }
  });

  it("refuses a Wahlperiode the Landtag's robots.txt disallows", async () => {
    for (const period of ROBOTS_DISALLOWED_PERIODS) {
      await rejects(() => new NordrheinWestfalenSource().discover(options({ period })), /robots\.txt disallows/);
    }
  });

  it("allows the periods robots.txt does not disallow", async () => {
    // 18 is current; the disallow list stops at 15.
    const result = await new NordrheinWestfalenSource().discover(options({ period: 18 }));
    ok(result.refs.length >= 1);
  });

  it("warns rather than silently accepting a link to another host", async () => {
    const foreign = NRW_HTML.replace(
      /href="https:\/\/www\.landtag\.nrw\.de[^"]*"/,
      'href="https://elsewhere.invalid/doc.pdf"',
    );
    const { transport } = scriptedTransport([{ match: "/suche", body: foreign }]);
    const result = await new NordrheinWestfalenSource().discover({
      engine: testEngine(transport),
      state: { source: "nordrhein-westfalen", http_cache: {} },
    });
    ok(result.warnings.some((warning) => warning.includes("elsewhere.invalid")));
  });
});

describe("the three defects NRW exposed", () => {
  it("does not date a question by the hidden 'Neuestes Dokument' span", () => {
    // The row carries the answer's date in a d-none span. Reading it as the
    // question's date is what kept NRW, Niedersachsen and others at zero results.
    const row =
      '<div>Drucksache 18/14414 : Kleine Anfrage; FDP; 20.06.2025; (2 S.)' +
      '<span class="d-none">; <span class="text-caps">Neuestes Dokument</span>: <span>25.07.2025</span></span>' +
      "</div>";
    strictEqual(visibleTextOf(row).includes("25.07.2025"), false);
    ok(visibleTextOf(row).includes("20.06.2025"));
  });

  it("strips a hidden element with nested tags of the same name", () => {
    // A lazy regex stops at the first `</span>` and leaves the date behind.
    const nested = '<span class="d-none">a<span>b</span>c</span>KEEP';
    strictEqual(stripHidden(nested).trim(), "KEEP");
  });

  it("dates a record by when it was asked, not when it was answered", () => {
    const ref = (dates: DocRef["dates"]): DocRef => ({
      key: "k",
      reference: "18/1",
      legislative_period: 18,
      title: "",
      documentType: "kleine_anfrage",
      askers: [],
      answered_by: {},
      dates,
      documents: [],
    });
    const engine = testEngine(async () => ({ status: 200, headers: {}, body: Buffer.alloc(0) }));
    const base = { engine, state: { source: "x", http_cache: {} }, since: "2025-01-01", until: "2025-06-30" };
    // Asked in June, answered in August: inside the window.
    strictEqual(applyWindow([ref({ submitted: "2025-06-20", answered: "2025-08-25" })], base).length, 1);
    // Asked in December: outside it, however recent the answer.
    strictEqual(applyWindow([ref({ submitted: "2024-12-01", answered: "2025-03-01" })], base).length, 0);
  });

  it("parses the NRW rows into references with both documents", () => {
    const blocks = blocksWithClass(NRW_HTML, "ps-vorgang", /<hr\s*\/?>/);
    const refs = blocks.map((block) => parseVorgangBlock(block, [])).filter((ref): ref is DocRef => ref !== undefined);
    ok(refs.length >= 1);
    for (const ref of refs) {
      strictEqual(ref.parliament, "nordrhein-westfalen");
      match(ref.reference, /^18\/\d+$/);
      ok(ref.dates.submitted !== undefined, "the question's own date must be read");
    }
    ok(refs.some((ref) => ref.documents.some((document) => document.role === "answer_pdf")));
  });

  it("sends no free-text query, which used to exclude whole Länder", async () => {
    const { transport, requests } = scriptedTransport([{ match: "/suche", body: NRW_HTML }]);
    await new NordrheinWestfalenSource().discover({
      engine: testEngine(transport),
      state: { source: "nordrhein-westfalen", http_cache: {} },
    });
    const url = requests[0]?.url ?? "";
    match(url, /fqDTyp=KlAnfr/);
    match(url, /qyVTyp=Anfrage/);
    strictEqual(/[?&]query=/.test(url), false);
  });
});
