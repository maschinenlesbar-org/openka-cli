// Thüringen, the one source that talks to a JSON API — and an undocumented one.
//
// Everything about that API is pinned here against recorded responses: the request
// bodies, the two-level JSON wrapping its answers use, and the way an unexpected
// shape becomes "no answer found" rather than a failed sync.

import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  FACET_KIND,
  FACET_LP,
  FACET_NUMBER,
  KIND_KLEINE_ANFRAGE,
  PARLDOK_WEB,
  ThueringenParldokSource,
  createSource,
  parseAuthors,
  answerPosition,
  firstHit,
  processBody,
  searchBody,
  successPayload,
} from "../src/index.js";
import { scriptedTransport, testEngine, fixtures } from "@maschinenlesbar.org/openka-lib-testing";

const { readFixtureText } = fixtures(import.meta.url);

const SEARCH = readFixtureText("payloads", "parldok-search.json");
const PROCESS = readFixtureText("payloads", "parldok-process.json");

describe("Parldok request bodies", () => {
  it("asks for one Kleine Anfrage by kind, number and Wahlperiode", () => {
    const body = JSON.parse(searchBody("979", 8)) as { tags: { type: number; id: unknown }[] };
    const byType = new Map(body.tags.map((tag) => [tag.type, tag.id]));
    strictEqual(byType.get(FACET_KIND), KIND_KLEINE_ANFRAGE);
    strictEqual(byType.get(FACET_NUMBER), "979");
    strictEqual(byType.get(FACET_LP), 8);
  });

  it("sends the defaults the endpoint requires", () => {
    // Omitting sort and topk makes it answer 500, which is how they were found.
    const body = JSON.parse(searchBody("1", 8)) as Record<string, unknown>;
    strictEqual(body["sort"], 0);
    strictEqual(body["topk"], 3);
    strictEqual(body["max"], 1000);
  });

  it("asks for a document's Vorgang by id and query id", () => {
    const body = JSON.parse(processBody(102282, 366775)) as Record<string, unknown>;
    strictEqual(body["id"], 102282);
    strictEqual(body["queryid"], 366775);
  });
});

describe("Parldok responses", () => {
  it("unwraps the payload, which arrives as JSON inside JSON", () => {
    const data = successPayload(SEARCH);
    ok(data !== undefined);
    strictEqual(typeof data["queryid"], "number");
  });

  it("treats anything but the success shape as nothing", () => {
    strictEqual(successPayload("not json"), undefined);
    strictEqual(successPayload('{"success":false,"data":"{}"}'), undefined);
    strictEqual(successPayload('{"success":true,"data":{"already":"an object"}}'), undefined);
    strictEqual(successPayload('{"success":true,"data":"not json either"}'), undefined);
  });

  it("reads the first hit and its query id", () => {
    const hit = firstHit(SEARCH);
    strictEqual(hit.kind, "found");
    strictEqual(hit.kind === "found" ? hit.value.id : undefined, 102282);
    strictEqual(hit.kind === "found" ? hit.value.queryId : undefined, 366775);
  });

  it("finds the answer among the Vorgang's positions", () => {
    const answer = answerPosition(PROCESS, PARLDOK_WEB);
    strictEqual(answer.kind, "found");
    // 8/979 is answered by 8/1715 — no relation between the numbers, which is why
    // the lookup exists at all.
    strictEqual(answer.kind === "found" ? answer.value.reference : undefined, "8/1715");
    match(answer.kind === "found" ? answer.value.url : "", new RegExp(`^${PARLDOK_WEB}/dokument/103169/`));
  });

  it("calls an empty result absent, not unrecognised", () => {
    strictEqual(answerPosition('{"success":true,"data":"{\\"process\\":{\\"positions\\":[]}}"}', PARLDOK_WEB).kind, "absent");
    strictEqual(firstHit('{"success":true,"data":"{\\"docs\\":[]}"}').kind, "absent");
  });

  it("calls an answer that has not been published yet absent, not unrecognised", () => {
    // A Vorgang nobody has answered carries a position *about* the answer:
    // "Gedruckte Antwort liegt noch nicht vor/wird noch erfasst". It matches
    // "Antwort" and has no document, and reading it as an answer we failed to
    // follow reported every open Kleine Anfrage as an API we no longer understand.
    const pending =
      '{"success":true,"data":"{\\"process\\":{\\"positions\\":[' +
      '{\\"text\\":\\"Gedruckte Antwort liegt noch nicht vor/wird noch erfasst\\",\\"doc\\":null}]}}"}';
    strictEqual(answerPosition(pending, PARLDOK_WEB).kind, "absent");
  });

  it("separates a response it does not understand from one that holds nothing", () => {
    // Both end the lookup with no answer, but only one of them means the API
    // changed under us, and a sync that cannot say which reports the wrong fact.
    strictEqual(firstHit("<html>Wartungsarbeiten</html>").kind, "unrecognised");
    strictEqual(firstHit('{"success":true,"data":"{}"}').kind, "unrecognised");
    strictEqual(answerPosition('{"success":true,"data":"{}"}', PARLDOK_WEB).kind, "unrecognised");
    strictEqual(answerPosition('{"success":true,"data":"{\\"process\\":{}}"}', PARLDOK_WEB).kind, "unrecognised");
    // An Antwort we can see and cannot follow is not an unanswered Anfrage either.
    const linkless = '{"success":true,"data":"{\\"process\\":{\\"positions\\":[{\\"text\\":\\"Antwort auf Kleine Anfrage\\",\\"doc\\":{}}]}}"}';
    strictEqual(answerPosition(linkless, PARLDOK_WEB).kind, "unrecognised");
  });
});

describe("Thüringen source", () => {
  const LISTING = readFixtureText("payloads", "parldok-listing.json");

  function transport(): ReturnType<typeof scriptedTransport> {
    return scriptedTransport([
      { match: "Fulltext/Search", body: LISTING },
      { match: "Process/Document", body: PROCESS },
    ]);
  }

  it("discovers the Kleine Anfragen from the Landtag's own API", async () => {
    const { transport: scripted } = transport();
    const result = await new ThueringenParldokSource().discover({
      engine: testEngine(scripted),
      state: { source: "thueringen", http_cache: {} },
    });
    strictEqual(result.refs.length, 13);
    for (const ref of result.refs) {
      match(ref.reference, /^8\/\d+$/);
      ok(ref.askers.length >= 1, `${ref.reference} has no asker`);
      ok(ref.dates.submitted !== undefined);
      ok(ref.documents.some((document) => document.role === "question_pdf"));
    }
  });

  it("attaches the answer Drucksache as a combined document", async () => {
    const { transport: scripted } = transport();
    const result = await new ThueringenParldokSource().discover({
      engine: testEngine(scripted),
      state: { source: "thueringen", http_cache: {} },
    });
    // The answer Drucksache reprints the question above the reply.
    ok(result.refs.some((ref) => ref.documents.some((document) => document.role === "combined_pdf")));
  });

  it("costs one request per answer, not two", async () => {
    // The listing already carries the document id and the query id, so the
    // per-ref search the aggregator path needed is gone.
    const { transport: scripted, requests } = transport();
    await new ThueringenParldokSource().discover({
      engine: testEngine(scripted),
      state: { source: "thueringen", http_cache: {} },
      limit: 200,
    });
    strictEqual(requests.filter((request) => request.url.includes("Fulltext/Search")).length, 1);
    strictEqual(requests.filter((request) => request.url.includes("Process/Document")).length, 13);
  });

  it("asks for the Kleine Anfrage Dokumentart, the Wahlperiode and the window", async () => {
    const { transport: scripted, requests } = transport();
    await new ThueringenParldokSource().discover({
      engine: testEngine(scripted),
      state: { source: "thueringen", http_cache: {} },
      period: 8,
      since: "2026-09-01",
      until: "2026-09-07",
    });
    const sent = requests.find((request) => request.url.includes("Fulltext/Search"));
    strictEqual(sent?.method, "POST");
    match(sent?.headers?.["content-type"] ?? "", /application\/x-www-form-urlencoded/);
    const body = JSON.parse(decodeURIComponent(String(sent?.body ?? "").replace(/^data=/, "")));
    const tags = body.tags as { type: number; id: string | number; field?: string }[];
    // Thüringen files the question type under Dokumentart (facet 7), not Dokumenttyp.
    ok(tags.some((tag) => tag.type === 7 && tag.id === "5"));
    ok(tags.some((tag) => tag.type === 10 && tag.id === 8));
    ok(tags.some((tag) => tag.type === 9 && tag.field === "datefrom" && tag.id === "01.09.2026"));
  });

  it("reports an unfamiliar response as unreadable, not as an empty Land", async () => {
    const { transport: scripted } = scriptedTransport([
      { match: "Fulltext/Search", body: "<html>Wartungsarbeiten</html>" },
    ]);
    const result = await new ThueringenParldokSource().discover({
      engine: testEngine(scripted),
      state: { source: "thueringen", http_cache: {} },
    });
    deepStrictEqual(result.refs, []);
    ok(result.unreadable?.includes("does not know"));
  });

  it("reads the members who asked, and their Fraktion", () => {
    deepStrictEqual(parseAuthors("Kerstin D&#252;ben-Schaumann (AfD)"), [
      { name: "Kerstin Düben-Schaumann", party: "AfD" },
    ]);
    deepStrictEqual(parseAuthors("A B (CDU), C D (Die Linke)"), [
      { name: "A B", party: "CDU" },
      { name: "C D", party: "Die Linke" },
    ]);
  });
});

describe("what createSource returns", () => {
  it("is the Landtag's own API, with the aggregator only behind it", async () => {
    const { transport: scripted, requests } = scriptedTransport([
      { match: "Fulltext/Search", body: readFixtureText("payloads", "parldok-listing.json") },
      { match: "Process/Document", body: PROCESS },
      { match: "/suche", body: "<html>should not be reached</html>" },
    ]);
    const result = await createSource().discover({
      engine: testEngine(scripted),
      state: { source: "thueringen", http_cache: {} },
    });
    strictEqual(result.refs.length, 13);
    ok(!requests.some((request) => request.url.includes("parlamentsspiegel")));
  });
});
