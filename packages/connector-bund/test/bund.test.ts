// The Bundestag connector, driven against a recorded DIP response.

import { deepStrictEqual, match, ok, rejects, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { OpenKaApiError, UsageError } from "@maschinenlesbar.org/openka-lib-errors";
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

  it("refuses a key a header cannot carry as a usage error, before any request", async () => {
    let requests = 0;
    const engine = testEngine(async () => {
      requests++;
      return { status: 200, headers: {}, body: Buffer.from("{}") };
    });
    for (const apiKey of ["sec\u007fret", "sec\nret", "secret\u202e", "sec\u0085ret"]) {
      await rejects(
        () => new BundDipSource().discover({ engine, state: { source: "bund", http_cache: {} }, apiKey }),
        (err: unknown) => err instanceof UsageError && /control characters/.test(err.message) && !err.message.includes("sec"),
        JSON.stringify(apiKey),
      );
      await rejects(() => new BundDipSource().count({ engine, apiKey }), UsageError, JSON.stringify(apiKey));
    }
    strictEqual(requests, 0);
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

describe("an answer DIP did not shape as a list", () => {
  it("is an error, not an empty window", async () => {
    // `{"numFound": 6}` without `documents` read as "0 discovered", exit 0 — while an
    // empty result does carry `"documents": []` (checked live 2026-10-13)
    // (exploratory 2026-10-13-bund, B02-2).
    const { transport } = scriptedTransport([{ match: "/api/v1/vorgangsposition", body: '{"numFound":6}' }]);
    await rejects(
      () => new BundDipSource().discover({ engine: testEngine(transport), apiKey: "k", state: { source: "bund", http_cache: {} }, since: "2026-06-01" }),
      /without a documents list/,
    );
  });
});

describe("a walk that reaches the page cap", () => {
  it("says the window was not discovered to its end", async () => {
    // Discovery stopped after 200 pages without a word: 1,007 of 1,200 Anfragen in the
    // mock, and Wahlperiode 19 holds 23,384 positions — 234 of DIP's pages
    // (exploratory 2026-10-13-bund, B02-1).
    let page = 0;
    const engine = testEngine(async (request) => {
      if (request.url.includes("f.vorgang=")) return { status: 200, headers: {}, body: Buffer.from('{"numFound":0,"documents":[],"cursor":"*"}') };
      page++;
      const documents = [{ id: `p${page}`, vorgang_id: `v${page}`, vorgangsposition: "Kleine Anfrage" }];
      return { status: 200, headers: {}, body: Buffer.from(JSON.stringify({ numFound: 23384, documents, cursor: `c${page}` })) };
    });
    const result = await new BundDipSource().discover({ engine, apiKey: "k", state: { source: "bund", http_cache: {} }, period: 19 });
    strictEqual(page, 200);
    match(result.warnings.join("\n"), /stopped after 200 pages \(200 of 23384 positions\).*--since\/--until/);
  });
});

describe("a cursor that moves without moving on", () => {
  it("stops when a page brings nothing new, and says so", async () => {
    // A new cursor with the same documents on every page cost 200 requests and the run
    // went on as if complete (exploratory 2026-10-13-bund, B02-3).
    let walk = 0;
    const engine = testEngine(async (request) => {
      if (request.url.includes("f.vorgang=")) return { status: 200, headers: {}, body: Buffer.from('{"numFound":0,"documents":[],"cursor":"*"}') };
      walk++;
      const documents = [{ id: "p1", vorgang_id: "v1", vorgangsposition: "Kleine Anfrage" }];
      // DIP says there is more than it hands out: the cursor moves, the page does not.
      return { status: 200, headers: {}, body: Buffer.from(JSON.stringify({ numFound: 5, documents, cursor: `c${walk}` })) };
    });
    const result = await new BundDipSource().discover({ engine, apiKey: "k", state: { source: "bund", http_cache: {} }, period: 21 });
    strictEqual(walk, 2);
    match(result.warnings.join("\n"), /cursor stopped making progress/);
  });
});

describe("a key DIP rejects", () => {
  it("is named as a rejected key, with the fix, never quoted", async () => {
    // A rejected key read as a bare "HTTP 401 for GET …" (exploratory 2026-10-13-bund,
    // B03-1); the Bundestag rotates its public key, so this is the error users meet.
    for (const status of [401, 403]) {
      const { transport } = scriptedTransport([{ match: "dip.bundestag.de", status, body: '{"code":401,"message":"Unauthorized"}' }]);
      const check = (err: unknown): boolean => {
        ok(err instanceof OpenKaApiError, String(err));
        strictEqual(err.status, status);
        match(err.message, new RegExp(`DIP rejected the API key \\(HTTP ${status}\\)`));
        match(err.message, /ka config set bund\.api-key/);
        ok(!err.message.includes("secret-key"));
        return true;
      };
      await rejects(
        () => new BundDipSource().discover({ engine: testEngine(transport), apiKey: "secret-key", state: { source: "bund", http_cache: {} }, period: 21 }),
        check,
      );
      await rejects(() => new BundDipSource().count({ engine: testEngine(transport), apiKey: "secret-key" }), check);
    }
  });
});

describe("a Vorgang with two Antwort positions", () => {
  it("keeps the first answer whatever order DIP lists them in, and names the other", () => {
    // `positions.find` took whichever DIP listed first: a correction three days later
    // replaced the original answer, and a re-sync overwrote a correct record
    // (exploratory 2026-10-13-bund, B01-5).
    const question = { vorgangsposition: "Kleine Anfrage", fundstelle: { dokumentnummer: "21/1000", pdf_url: "https://x.invalid/q.pdf", datum: "2026-06-01" } };
    const first = { vorgangsposition: "Antwort", fundstelle: { dokumentnummer: "21/5000", pdf_url: "https://x.invalid/a.pdf", datum: "2026-06-15" } };
    const later = { vorgangsposition: "Antwort", fundstelle: { dokumentnummer: "21/8000", pdf_url: "https://x.invalid/b.pdf", datum: "2026-06-18" } };
    for (const order of [[question, later, first], [question, first, later]]) {
      const warnings: string[] = [];
      const ref = toRef("400000", order, warnings);
      deepStrictEqual(ref?.documents.map((document) => document.url), ["https://x.invalid/q.pdf", "https://x.invalid/a.pdf"]);
      strictEqual(ref?.dates.answered, "2026-06-15");
      match(warnings.join("\n"), /Vorgang 400000: 2 "Antwort" positions; the first \(21\/5000, 2026-06-15\) is archived, 21\/8000 is not/);
    }
  });
});

/**
 * A DIP with `n` Kleine Anfragen of WP 21: `perDay` questions a day from 2026-06-01, each
 * answered `lag` days later, the last `unanswered` not yet. It filters like DIP — by
 * position date, Wahlperiode and Vorgang (repeated `f.vorgang` ORed, as DIP does; checked
 * live 2026-10-13) — lists newest first, and pages by a cursor that stops moving at the end.
 */
function dip(options: { n: number; perDay?: number; lag?: number; unanswered?: number; pageSize?: number }) {
  const day = (offset: number): string => new Date(Date.UTC(2026, 5, 1 + offset)).toISOString().slice(0, 10);
  const positions: Record<string, unknown>[] = [];
  for (let i = 0; i < options.n; i++) {
    const offset = Math.floor(i / (options.perDay ?? 1));
    const vorgang = String(400000 + i);
    positions.push({
      id: `q${i}`, vorgang_id: vorgang, vorgangsposition: "Kleine Anfrage", titel: `Anfrage ${i}`, datum: day(offset),
      fundstelle: { dokumentnummer: `21/${1000 + i}`, datum: day(offset), pdf_url: `https://dserver.invalid/q${i}.pdf` },
    });
    if (i >= options.n - (options.unanswered ?? 0)) continue;
    const answered = day(offset + (options.lag ?? 14));
    positions.push({
      id: `a${i}`, vorgang_id: vorgang, vorgangsposition: "Antwort", titel: `Anfrage ${i}`, datum: answered,
      fundstelle: { dokumentnummer: `21/${5000 + i}`, datum: answered, pdf_url: `https://dserver.invalid/a${i}.pdf` },
    });
  }
  const requests: URL[] = [];
  const engine = testEngine(async (request) => {
    const url = new URL(request.url);
    requests.push(url);
    const query = url.searchParams;
    const vorgaenge = query.getAll("f.vorgang");
    const matching = positions
      .filter((p) => query.get("f.datum.start") === null || (p["datum"] as string) >= (query.get("f.datum.start") as string))
      .filter((p) => query.get("f.datum.end") === null || (p["datum"] as string) <= (query.get("f.datum.end") as string))
      .filter((p) => query.get("f.wahlperiode") === null || String((p["fundstelle"] as { dokumentnummer: string }).dokumentnummer).startsWith(`${query.get("f.wahlperiode")}/`))
      .filter((p) => vorgaenge.length === 0 || vorgaenge.includes(p["vorgang_id"] as string))
      .sort((a, b) => ((a["datum"] as string) < (b["datum"] as string) ? 1 : (a["datum"] as string) > (b["datum"] as string) ? -1 : 0));
    const offset = Number(query.get("cursor") ?? "0");
    const documents = matching.slice(offset, offset + (options.pageSize ?? 100));
    const cursor = String(offset + documents.length);
    return { status: 200, headers: {}, body: Buffer.from(JSON.stringify({ numFound: matching.length, documents, cursor })) };
  });
  return { engine, requests, completions: () => requests.filter((url) => url.searchParams.has("f.vorgang")) };
}
const STATE = { source: "bund", http_cache: {} };

describe("completing the pairs of a busy window", () => {
  it("pairs every question of the window with its answer, in a few requests", async () => {
    // 150 questions in the window, 70 of them answered after it, and 70 answers in it
    // to questions before it. Completion was 50 single-Vorgang requests in id order,
    // spent first on those earlier pairs — dropped by the window afterwards — so 70
    // records were stored without the answers DIP had, and a re-run spent the same
    // 50 again (exploratory 2026-10-13-bund, B01-1; August 2026 held 217 half pairs).
    const { engine, completions } = dip({ n: 300, perDay: 5, lag: 14 });
    const result = await new BundDipSource().discover({ engine, apiKey: "k", state: STATE, since: "2026-06-15", until: "2026-07-14" });
    strictEqual(result.refs.length, 150);
    const unanswered = result.refs.filter((ref) => ref.dates.answered === undefined).map((ref) => ref.reference);
    deepStrictEqual(unanswered, []);
    ok(completions().length <= 10, `${completions().length} completion requests`);
    ok(!result.warnings.some((warning) => warning.includes("stopped completing")), result.warnings.join("\n"));
  });
});

describe("an answer to a question an earlier window stored", () => {
  // A daily or weekly sync stores most questions before they are answered. The next
  // window holds their answers, completed the pairs — and dropped them, since the window
  // filters on the question's date: those records stayed unanswered for good
  // (exploratory 2026-10-13-bund, B05-1).
  const held = (ids: string[]) => ({ loadArtifact: () => undefined, hasRecord: (id: string) => ids.includes(id) });

  it("updates the stored record", async () => {
    const { engine } = dip({ n: 10, lag: 14 });
    const stored = Array.from({ length: 10 }, (_, i) => `bund-21-${1000 + i}`);
    const result = await new BundDipSource().discover({ engine, apiKey: "k", state: STATE, store: held(stored), since: "2026-06-11", until: "2026-06-30" });
    deepStrictEqual(
      result.refs.map((ref) => [ref.reference, ref.dates.answered !== undefined]).sort(),
      stored.map((id) => [`21/${id.slice(-4)}`, true]),
    );
  });

  it("is still left out when the corpus does not hold the question", async () => {
    const { engine } = dip({ n: 10, lag: 14 });
    const result = await new BundDipSource().discover({ engine, apiKey: "k", state: STATE, store: held(["bund-21-1003"]), since: "2026-06-11", until: "2026-06-30" });
    deepStrictEqual(result.refs.map((ref) => ref.reference), ["21/1003"]);
  });
});

describe("answers the completion did not reach", () => {
  it("are not reported as Vorgänge without a question", async () => {
    // Past the budget, each answer whose question lies before the window was reported as
    // `Vorgang N: no "Kleine Anfrage" position found; skipped` — read as broken DIP data;
    // the Vorgang has its question, in an earlier window (exploratory 2026-10-13-bund, B01-2).
    const { engine } = dip({ n: 2400, perDay: 40, lag: 14 });
    const store = { loadArtifact: () => undefined, hasRecord: () => false };
    const result = await new BundDipSource().discover({ engine, apiKey: "k", state: STATE, store, since: "2026-06-15", until: "2026-07-14" });
    ok(result.warnings.some((warning) => warning.includes("stopped completing")), "the budget is reached here");
    deepStrictEqual(result.warnings.filter((warning) => warning.includes('no "Kleine Anfrage" position')), []);
  });

  it("are not asked for when no stored question could take them", async () => {
    const { engine, completions } = dip({ n: 10, lag: 14 });
    const result = await new BundDipSource().discover({ engine, apiKey: "k", state: STATE, since: "2026-06-11", until: "2026-06-30" });
    deepStrictEqual(result.refs, []);
    strictEqual(completions().length, 0);
  });
});

describe("questions DIP has no answer to yet", () => {
  it("are not completed when the query already reaches to today", async () => {
    // A period sync with 60 of 100 questions unanswered spent 50 completions (100
    // requests) on them and warned "stopped completing … re-run", missing nothing
    // (exploratory 2026-10-13-bund, B01-4). Without --until the query lists every later
    // answer, so a question alone in it has none yet.
    for (const window of [{ period: 21 }, { since: "2026-06-01" }]) {
      const { engine, completions } = dip({ n: 100, unanswered: 60 });
      const result = await new BundDipSource().discover({ engine, apiKey: "k", state: STATE, ...window });
      strictEqual(result.refs.length, 100, JSON.stringify(window));
      strictEqual(result.refs.filter((ref) => ref.dates.answered === undefined).length, 60);
      strictEqual(completions().length, 0, JSON.stringify(window));
      ok(!result.warnings.some((warning) => warning.includes("stopped completing")));
    }
  });
});

describe("--limit", () => {
  it("bounds the completion to the Anfragen it keeps", async () => {
    // `--limit 1` sent 101 requests to DIP: every half pair of the first page was
    // completed, and the limit applied afterwards (exploratory 2026-10-13-bund, B01-3).
    for (const limit of [1, 3]) {
      const { engine, requests, completions } = dip({ n: 300, perDay: 5, lag: 14 });
      const result = await new BundDipSource().discover({ engine, apiKey: "k", state: STATE, since: "2026-06-15", until: "2026-07-14", limit });
      strictEqual(result.refs.length, limit);
      ok(completions().length <= 1, `${completions().length} completion requests for --limit ${limit}`);
      ok(requests.length <= 3, `${requests.length} requests for --limit ${limit}`);
    }
  });
});
