// The Bundestag connector, driven against a recorded DIP response.

import { deepStrictEqual, match, ok, rejects, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { BundDipSource, FIRST_VORGANG_DATE, askersOf, drucksacheRef, drucksacheWindow, parseDipAuthor, toRef } from "../src/index.js";
import { scriptedTransport, testEngine, fixtures } from "@maschinenlesbar.org/openka-lib-testing";

const { readFixtureText } = fixtures(import.meta.url);

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

describe("counting DIP (issue #5)", () => {
  it("counts the Vorgänge of a period from the 8th on, and the Drucksachen before them", async () => {
    const { transport, requests } = scriptedTransport([
      { match: "/api/v1/vorgang", body: '{"numFound":39124,"documents":[]}' },
      { match: "/api/v1/drucksache", body: '{"numFound":2747,"documents":[]}' },
    ]);
    const source = new BundDipSource();
    deepStrictEqual(await source.count({ engine: testEngine(transport), apiKey: "k", period: 21 }), { total: 39124, basis: "DIP numFound" });
    deepStrictEqual(await source.count({ engine: testEngine(transport), apiKey: "k", period: 3 }), { total: 2747, basis: "DIP numFound (Drucksachen)" });
    deepStrictEqual(await source.count({ engine: testEngine(transport), apiKey: "k" }), {
      total: 41871,
      basis: "DIP numFound (Drucksachen to WP 7, Vorgänge from WP 8)",
    });
    const asked = requests.map((request) => {
      const url = new URL(request.url);
      return [url.pathname, url.searchParams.get("f.wahlperiode"), url.searchParams.get("f.datum.end")];
    });
    deepStrictEqual(asked, [
      ["/api/v1/vorgang", "21", null],
      ["/api/v1/drucksache", "3", null],
      ["/api/v1/vorgang", null, null],
      ["/api/v1/drucksache", null, "1976-12-13"],
    ]);
    strictEqual(requests[0]?.headers?.["authorization"], "ApiKey k");
  });

  it("needs its key, and refuses an answer without numFound", async () => {
    const { transport } = scriptedTransport([{ match: "/api/v1/vorgang", body: '{"documents":[]}' }]);
    await rejects(new BundDipSource().count({ engine: testEngine(transport) }), /needs a key/);
    await rejects(new BundDipSource().count({ engine: testEngine(transport), apiKey: "k" }), /no numFound/);
  });
});

describe("the 1st to 7th Wahlperiode, from DIP's Drucksachen (issue #7)", () => {
  const payload = readFixtureText("payloads", "dip-drucksache-wp7.json");

  it("serves a period up to the 7th, or a window before the first Vorgang, from the Drucksachen", () => {
    deepStrictEqual(
      [{ period: 1 }, { period: 7 }, { period: 8 }, { until: "1976-12-13" }, { until: FIRST_VORGANG_DATE }, {}].map(drucksacheWindow),
      [true, true, false, true, false, false],
    );
  });

  it("makes a question-only ref of each Kleine Anfrage, and pairs no answer by guess", async () => {
    const { transport, requests } = scriptedTransport([{ match: "/api/v1/drucksache", body: payload }]);
    const result = await new BundDipSource().discover({ engine: testEngine(transport), apiKey: "k", state: { source: "bund", http_cache: {} }, period: 7 });
    const asked = new URL(requests[0]?.url ?? "").searchParams;
    deepStrictEqual([asked.get("f.drucksachetyp"), asked.get("f.wahlperiode")], ["Kleine Anfrage", "7"]);
    strictEqual(result.refs.length, 2);
    const ref = result.refs.find((candidate) => candidate.reference === "07/5896");
    deepStrictEqual(
      [ref?.legislative_period, ref?.dates, ref?.documents, ref?.answered_by, ref?.askers.length, ref?.askers[0]],
      [7, { submitted: "1976-11-23" }, [{ role: "question_pdf", url: "https://dserver.bundestag.de/btd/07/058/0705896.pdf", urlStable: true }], {}, 4, { name: "Anton Pfeifer", role: "MdB", party: "CDU/CSU" }],
    );
    match(result.warnings.join("\n"), /2 Kleine Anfrage\(n\) from DIP's Drucksachen .* stored with its answers abstained rather than paired by guess/);
  });

  it("says that a discovery reaching before 1976 misses the Drucksache-only periods", async () => {
    const { transport } = scriptedTransport([{ match: "/api/v1/vorgangsposition", body: '{"documents":[]}' }]);
    const discover = (window: { since?: string }) =>
      new BundDipSource().discover({ engine: testEngine(transport), apiKey: "k", state: { source: "bund", http_cache: {} }, ...window });
    match((await discover({})).warnings.join("\n"), /before 1976-12-14 \(Wahlperioden 1–7\) have no Vorgang/);
    deepStrictEqual((await discover({ since: "2026-01-01" })).warnings, []);
  });

  it("skips a Drucksache without a number, and keeps one without a PDF as metadata", () => {
    const warnings: string[] = [];
    strictEqual(drucksacheRef({ id: "1" }, warnings), undefined);
    const ref = drucksacheRef({ id: "2", dokumentnummer: "03/120", wahlperiode: 3, titel: "T", fundstelle: { datum: "1958-01-02" } }, warnings);
    deepStrictEqual([ref?.documents, ref?.dates.submitted], [[], "1958-01-02"]);
    deepStrictEqual(warnings, ["Drucksache 1: no Drucksachennummer; skipped", "Drucksache 03/120: DIP names no PDF; stored with metadata only"]);
  });
});
