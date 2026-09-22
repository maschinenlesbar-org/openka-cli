// Bremen, driven against a recorded PARiS session: the search form and a real
// 01.09–10.09.2026 result page for WP 21.

import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { BremenParisSource, FIELD, createSource, parseRecordLine, parseTitle, toRef } from "../src/index.js";
import { recordBlocks, blockText } from "@maschinenlesbar.org/openka-lib-starweb";
import { scriptedTransport, testEngine, fixtures } from "@maschinenlesbar.org/openka-lib-testing";

const { readFixtureText } = fixtures(import.meta.url);
const FORM = readFixtureText("payloads", "paris-search-form.html");
const RESULTS = readFixtureText("payloads", "paris-results.html");
const state = { source: "bremen", http_cache: {} };

describe("a PARiS result line", () => {
  it("reads the Drucksachennummer, the type, the date and the Fraktion", () => {
    deepStrictEqual(parseRecordLine("… Drs 21/1983 , Kleine Anfrage vom 10.09.2026 BIW"), {
      reference: "21/1983",
      period: 21,
      chamber: "land",
      documentType: "Kleine Anfrage",
      date: "10.09.2026",
      fraktion: "BIW",
    });
  });

  it("captures the chamber marker instead of failing to match on it", () => {
    // `S` sits inside the line, before the comma. Letting it break the match would
    // make a Stadtbürgerschaft paper indistinguishable from a changed template.
    const stadt = parseRecordLine("… Drs 21/905 S , Kleine Anfrage vom 09.09.2026 BIW");
    strictEqual(stadt?.chamber, "stadt");
    strictEqual(stadt?.reference, "21/905");
  });

  it("takes the title from the head, without the chamber or the keywords", () => {
    strictEqual(
      parseTitle("L Zivilklausel im Hochschulgesetz , Hochschulrecht , Gutachten Drs 21/1983 , Kleine Anfrage vom 10.09.2026 BIW"),
      "Zivilklausel im Hochschulgesetz",
    );
  });

  it("parses every record on the recorded page", () => {
    const lines = recordBlocks(RESULTS).map((block) => parseRecordLine(blockText(block)));
    strictEqual(lines.filter((line) => line === undefined).length, 0);
    strictEqual(lines.filter((line) => line?.chamber === "land").length, 8);
    strictEqual(lines.filter((line) => line?.chamber === "stadt").length, 3);
  });
});

describe("Bremen source", () => {
  function transport(): ReturnType<typeof scriptedTransport> {
    return scriptedTransport([
      { match: "path=paris%2FLISSH.web", body: FORM },
      { match: "servlet.starweb", body: RESULTS },
    ]);
  }

  it("discovers the Land chamber's Kleine Anfragen", async () => {
    const { transport: scripted } = transport();
    const result = await new BremenParisSource().discover({ engine: testEngine(scripted), state });
    // 11 records on the page, 3 of them the Stadtbürgerschaft's.
    strictEqual(result.refs.length, 8);
    for (const ref of result.refs) {
      match(ref.reference, /^21\/\d+$/);
      strictEqual(ref.documentType, "kleine_anfrage");
      ok(ref.dates.submitted !== undefined);
      match(ref.documents[0]?.url ?? "", /\/D21L\d+\.pdf$/);
    }
  });

  it("leaves out the Stadtbürgerschaft", async () => {
    const { transport: scripted } = transport();
    const result = await new BremenParisSource().discover({ engine: testEngine(scripted), state });
    ok(!result.refs.some((ref) => /D\d+S\d+\.pdf$/.test(ref.documents[0]?.url ?? "")));
  });

  it("selects the type through Dokumenttyp, which is the field that works", async () => {
    // `06_LISSH_VTYP=Kleine Anfrage` matches nothing at all, with no error.
    const { transport: scripted, requests } = transport();
    await new BremenParisSource().discover({
      engine: testEngine(scripted),
      state,
      period: 21,
      since: "2026-09-01",
      until: "2026-09-10",
    });
    const post = requests.find((request) => request.method === "POST");
    const body = new URLSearchParams(String(post?.body ?? ""));
    strictEqual(body.get(FIELD.documentType), "Kleine Anfrage");
    strictEqual(body.get(FIELD.period), "21");
    strictEqual(body.get(FIELD.dateFrom), "01.09.2026");
    strictEqual(body.get(FIELD.dateTo), "10.09.2026");
    // The session has to come back with the search, or PARiS answers with the form.
    ok(body.get("__websessionID") !== null);
    strictEqual(body.get("__action"), "20");
  });

  it("reports a form with no session as unreadable, not as an empty Land", async () => {
    const { transport: scripted } = scriptedTransport([
      { match: "servlet.starweb", body: "<html>Wartungsarbeiten</html>" },
    ]);
    const result = await new BremenParisSource().discover({ engine: testEngine(scripted), state });
    deepStrictEqual(result.refs, []);
    ok(result.unreadable?.includes("session"));
  });

  it("calls a genuine empty window empty, not unreadable", async () => {
    const { transport: scripted } = scriptedTransport([
      { match: "path=paris%2FLISSH.web", body: FORM },
      { match: "servlet.starweb", body: "<html>Ihre Suche hat keine Treffer ergeben.</html>" },
    ]);
    const result = await new BremenParisSource().discover({ engine: testEngine(scripted), state });
    deepStrictEqual(result.refs, []);
    strictEqual(result.unreadable, undefined);
  });

  it("skips a row that links no PDF, and says so", () => {
    const warnings: string[] = [];
    strictEqual(toRef("Drs 21/1 , Kleine Anfrage vom 01.01.2026 BIW", warnings), undefined);
    strictEqual(warnings.length, 1);
  });
});

describe("what createSource returns", () => {
  it("is the Bürgerschaft's own PARiS, with the aggregator only behind it", async () => {
    const { transport: scripted, requests } = scriptedTransport([
      { match: "path=paris%2FLISSH.web", body: FORM },
      { match: "servlet.starweb", body: RESULTS },
      { match: "/suche", body: "<html>should not be reached</html>" },
    ]);
    const result = await createSource().discover({ engine: testEngine(scripted), state });
    strictEqual(result.refs.length, 8);
    ok(!requests.some((request) => request.url.includes("parlamentsspiegel")));
  });
});
