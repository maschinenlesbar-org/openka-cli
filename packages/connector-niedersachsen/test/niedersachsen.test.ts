// Niedersachsen: the one source whose answers are recovered by a build-time sweep
// rather than by asking an interface, because no interface exposes the link.

import { deepStrictEqual, match, ok, rejects, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ANSWER_INDEX,
  NiedersachsenSource,
  citedQuestion,
  isAnsweredEdition,
  niedersachsenUrl,
  numberOf,
  isCovered,
  mergeRanges,
  type AnswerIndex,
} from "../src/index.js";
import { sweepAnswers } from "@maschinenlesbar.org/openka-cli-ka-factory";
import { MemoryStore, scriptedTransport, testEngine, fixturesOf } from "@maschinenlesbar.org/openka-lib-testing";

const { readFixtureText } = fixturesOf("@maschinenlesbar.org/openka-lib-parlamentsspiegel", import.meta.url);

describe("Niedersachsen archive URLs", () => {
  it("nests a Drucksache in its 2500 and 500 blocks", () => {
    // Verified live across six numbers spanning both folder boundaries.
    strictEqual(
      niedersachsenUrl(19, 7605),
      "https://www.landtag-niedersachsen.de/Drucksachen/Drucksachen_19_10000/07501-08000/19-07605.pdf",
    );
    strictEqual(
      niedersachsenUrl(19, 7404),
      "https://www.landtag-niedersachsen.de/Drucksachen/Drucksachen_19_07500/07001-07500/19-07404.pdf",
    );
  });

  it("puts a block boundary in the lower block", () => {
    match(niedersachsenUrl(19, 5000), /Drucksachen_19_05000\/04501-05000\/19-05000\.pdf$/);
    match(niedersachsenUrl(19, 2501), /Drucksachen_19_05000\/02501-03000\/19-02501\.pdf$/);
  });

  it("reads the numeric part of a Drucksachennummer", () => {
    strictEqual(numberOf("19/7605"), 7605);
    strictEqual(numberOf("19 / 7605"), 7605);
    strictEqual(numberOf("Drucksache 19/7605"), undefined);
  });
});

describe("recognising an answered edition", () => {
  it("knows the Landtag's own phrase", () => {
    ok(isAnsweredEdition("Kleine Anfrage zur schriftlichen Beantwortung\nmit Antwort der Landesregierung"));
    strictEqual(isAnsweredEdition("Kleine Anfrage zur schriftlichen Beantwortung\ngemäß § 46 Abs. 1 GO LT"), false);
  });

  it("reads the question an answer names", () => {
    // The header cites it abbreviated: "Drs. 19/7745".
    strictEqual(citedQuestion("… eingegangen am 10.07.2025 -\nDrs. 19/7745,\nan die Staatskanzlei"), "19/7745");
    strictEqual(citedQuestion("Drs 19/7745"), "19/7745");
  });

  it("names no question rather than guessing one", () => {
    strictEqual(citedQuestion("Antwort der Landesregierung ohne Bezug"), undefined);
  });
});

describe("the answer sweep", () => {
  /** A one-page PDF holding the given lines, so the sweep can be driven end to end. */
  function pdf(lines: string[]): Buffer {
    const content = lines
      .map((line, i) => `BT /F1 12 Tf 72 ${760 - i * 18} Td (${line.replace(/([()\\])/g, "\\$1")}) Tj ET`)
      .join("\n");
    return Buffer.from(
      [
        "%PDF-1.4",
        "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
        "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
        "3 0 obj << /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >> endobj",
        `4 0 obj << /Length ${content.length} >> stream\n${content}\nendstream endobj`,
        "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >> endobj",
        "trailer << /Root 1 0 R >>",
        "%%EOF",
      ].join("\n"),
      "latin1",
    );
  }

  const answer = pdf(["Kleine Anfrage zur schriftlichen Beantwortung", "mit Antwort der Landesregierung", "Drs. 19/7745,"]);
  const question = pdf(["Kleine Anfrage zur schriftlichen Beantwortung", "gemaess 46 Abs. 1 GO LT"]);

  function sweep(store = new MemoryStore()) {
    const { transport } = scriptedTransport([
      { match: "19-08100.pdf", body: answer },
      { match: "19-08101.pdf", body: question },
      { match: "19-08102.pdf", status: 404, body: "nope" },
    ]);
    return { store, engine: testEngine(transport) };
  }

  it("maps a question to the answer that names it", async () => {
    const { store, engine } = sweep();
    const report = await sweepAnswers({ engine, store, period: 19, from: 8100, to: 8102, now: "2026-01-02T03:04:05Z" });
    deepStrictEqual(
      { scanned: report.scanned, answers: report.answers, questions: report.questions, missing: report.missing },
      { scanned: 3, answers: 1, questions: 1, missing: 1 },
    );
    const index = store.loadArtifact<AnswerIndex>(ANSWER_INDEX);
    strictEqual(index?.answers["19/7745"]?.reference, "19/8100");
    match(index?.answers["19/7745"]?.url ?? "", /19-08100\.pdf$/);
  });

  it("treats a gap in the numbering as ordinary, not as an error", async () => {
    const { store, engine } = sweep();
    const report = await sweepAnswers({ engine, store, period: 19, from: 8102, to: 8102, now: "2026-01-02T03:04:05Z" });
    strictEqual(report.missing, 1);
    strictEqual(report.answers, 0);
  });

  it("stamps the artifact with when and what it swept", async () => {
    const { store, engine } = sweep();
    await sweepAnswers({ engine, store, period: 19, from: 8100, to: 8101, now: "2026-01-02T03:04:05Z" });
    const index = store.loadArtifact<AnswerIndex>(ANSWER_INDEX);
    strictEqual(index?.built_at, "2026-01-02T03:04:05Z");
    deepStrictEqual(index?.ranges, [{ from: 8100, to: 8101 }]);
  });

  it("keeps earlier entries when merging, and widens the recorded range", async () => {
    const store = new MemoryStore();
    store.saveArtifact(ANSWER_INDEX, {
      built_at: "2025-01-01T00:00:00Z",
      period: 19,
      ranges: [{ from: 1, to: 10 }],
      answers: { "19/1": { reference: "19/2", url: "https://x.invalid/a.pdf" } },
    } satisfies AnswerIndex);
    const { engine } = sweep(store);
    await sweepAnswers({ engine, store, period: 19, from: 8100, to: 8100, now: "2026-01-02T03:04:05Z", merge: true });
    const index = store.loadArtifact<AnswerIndex>(ANSWER_INDEX);
    strictEqual(index?.answers["19/1"]?.reference, "19/2");
    strictEqual(index?.answers["19/7745"]?.reference, "19/8100");
    // The two sweeps are disjoint, so they stay two ranges. Collapsing them to
    // 1..8100 would claim 8090 numbers had been read that nobody fetched.
    deepStrictEqual(index?.ranges, [
      { from: 1, to: 10 },
      { from: 8100, to: 8100 },
    ]);
    strictEqual(isCovered(index as AnswerIndex, 5000, 5000), false);
  });

  it("refuses to merge a sweep of a different legislative period", async () => {
    const store = new MemoryStore();
    store.saveArtifact(ANSWER_INDEX, {
      built_at: "2025-01-01T00:00:00Z",
      period: 18,
      ranges: [{ from: 1, to: 10 }],
      answers: {},
    } satisfies AnswerIndex);
    const { engine } = sweep(store);
    await rejects(
      () => sweepAnswers({ engine, store, period: 19, from: 8100, to: 8100, now: "2026-01-02T03:04:05Z", merge: true }),
      /period 18, not 19/,
    );
  });
});

describe("swept ranges", () => {
  it("coalesces overlapping and adjacent ranges but keeps disjoint ones apart", () => {
    deepStrictEqual(mergeRanges([{ from: 1, to: 10 }], { from: 11, to: 20 }), [{ from: 1, to: 20 }]);
    deepStrictEqual(mergeRanges([{ from: 1, to: 10 }], { from: 5, to: 20 }), [{ from: 1, to: 20 }]);
    deepStrictEqual(mergeRanges([{ from: 1, to: 10 }], { from: 12, to: 20 }), [
      { from: 1, to: 10 },
      { from: 12, to: 20 },
    ]);
  });

  it("reports a number in a gap as not covered", () => {
    const index = { built_at: "", period: 19, ranges: [{ from: 1, to: 10 }, { from: 100, to: 110 }], answers: {} };
    strictEqual(isCovered(index, 5, 5), true);
    strictEqual(isCovered(index, 50, 50), false);
    // A span that straddles a gap is not covered either.
    strictEqual(isCovered(index, 5, 105), false);
  });
});

describe("Niedersachsen source", () => {
  const html = readFixtureText("payloads", "parlamentsspiegel-niedersachsen.html");


  it("says so when the corpus has no answer map, rather than failing", async () => {
    const { transport } = scriptedTransport([{ match: "/suche", body: html }]);
    const result = await new NiedersachsenSource().discover({
      engine: testEngine(transport),
      store: new MemoryStore(),
      state: { source: "niedersachsen", http_cache: {} },
    });
    ok(result.refs.length >= 1);
    // The result row names the answer, so a corpus without the sweep is not
    // answer-less — it just lacks the confirmation that the sweep reads.
    ok(result.refs.every((ref) => ref.documents.some((document) => document.role === "answer_pdf")));
    ok(result.warnings.some((warning) => warning.includes("ka-factory answers niedersachsen")));
  });

  it("does not attach the answer twice when the map repeats the row's follow-up", async () => {
    const { transport } = scriptedTransport([{ match: "/suche", body: html }]);
    const store = new MemoryStore();
    const discovered = await new NiedersachsenSource().discover({
      engine: testEngine(transport),
      store,
      state: { source: "niedersachsen", http_cache: {} },
    });
    const reference = discovered.refs[0]?.reference as string;
    store.saveArtifact(ANSWER_INDEX, {
      built_at: "2026-01-02T03:04:05Z",
      period: 19,
      ranges: [{ from: 1, to: 9999 }],
      answers: { [reference]: { reference: "19/9999", url: "https://x.invalid/answer.pdf" } },
    } satisfies AnswerIndex);

    const result = await new NiedersachsenSource().discover({
      engine: testEngine(scriptedTransport([{ match: "/suche", body: html }]).transport),
      store,
      state: { source: "niedersachsen", http_cache: {} },
    });
    const documents = result.refs.find((ref) => ref.reference === reference)?.documents ?? [];
    deepStrictEqual(documents.map((document) => document.role), ["question_pdf", "combined_pdf"]);
  });

  it("attaches the answer when the map has one", async () => {
    const { transport } = scriptedTransport([{ match: "/suche", body: html }]);
    const store = new MemoryStore();
    const discovered = await new NiedersachsenSource().discover({
      engine: testEngine(transport),
      store,
      state: { source: "niedersachsen", http_cache: {} },
    });
    const reference = discovered.refs[0]?.reference as string;
    store.saveArtifact(ANSWER_INDEX, {
      built_at: "2026-01-02T03:04:05Z",
      period: 19,
      ranges: [{ from: 1, to: 9999 }],
      answers: { [reference]: { reference: "19/9999", url: "https://x.invalid/answer.pdf" } },
    } satisfies AnswerIndex);

    const result = await new NiedersachsenSource().discover({
      engine: testEngine(scriptedTransport([{ match: "/suche", body: html }]).transport),
      store,
      state: { source: "niedersachsen", http_cache: {} },
    });
    const roles = result.refs[0]?.documents.map((document) => document.role) ?? [];
    ok(roles.includes("question_pdf"));
    // The answer paper reprints the question above the reply.
    ok(roles.includes("combined_pdf"));
  });
});
