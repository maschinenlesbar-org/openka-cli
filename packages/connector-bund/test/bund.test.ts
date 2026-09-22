// The Bundestag connector, driven against a recorded DIP response.

import { deepStrictEqual, match, ok, rejects, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { BundDipSource, askersOf, parseDipAuthor, toRef } from "../src/index.js";
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
