// Thüringen, the one source that talks to a JSON API — and an undocumented one.
//
// Everything about that API is pinned here against recorded responses: the request
// bodies, the two-level JSON wrapping its answers use, and the way an unexpected
// shape becomes "no answer found" rather than a failed sync.

import { match, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  FACET_KIND,
  FACET_LP,
  FACET_NUMBER,
  KIND_KLEINE_ANFRAGE,
  PARLDOK_WEB,
  ThueringenSource,
  answerPosition,
  firstHit,
  processBody,
  searchBody,
  successPayload,
} from "../src/index.js";
import { scriptedTransport, testEngine, fixtures, fixturesOf } from "@maschinenlesbar.org/openka-lib-testing";

const { readFixtureText } = fixtures(import.meta.url);
// The result row that starts discovery is the aggregator's document, not Parldok's.
const ps = fixturesOf("@maschinenlesbar.org/openka-lib-parlamentsspiegel", import.meta.url);

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
  function transport(): ReturnType<typeof scriptedTransport> {
    return scriptedTransport([
      { match: "/suche", body: ps.readFixtureText("payloads", "parlamentsspiegel-thueringen.html") },
      { match: "Fulltext/Search", body: SEARCH },
      { match: "Process/Document", body: PROCESS },
    ]);
  }


  it("attaches the answer Drucksache as a combined document", async () => {
    const { transport: scripted } = transport();
    const result = await new ThueringenSource().discover({
      engine: testEngine(scripted),
      state: { source: "thueringen", http_cache: {} },
    });
    ok(result.refs.length >= 1);
    const roles = result.refs[0]?.documents.map((document) => document.role) ?? [];
    ok(roles.includes("question_pdf"));
    // The answer Drucksache reprints the question above the reply.
    ok(roles.includes("combined_pdf"));
  });

  it("posts to the API rather than fetching a page", async () => {
    const { transport: scripted, requests } = transport();
    await new ThueringenSource().discover({
      engine: testEngine(scripted),
      state: { source: "thueringen", http_cache: {} },
    });
    const search = requests.find((request) => request.url.includes("Fulltext/Search"));
    strictEqual(search?.method, "POST");
    match(String(search?.body ?? ""), /^data=%7B/);
    match(search?.headers?.["content-type"] ?? "", /application\/x-www-form-urlencoded/);
  });

  it("keeps the record when the API answers something unexpected", async () => {
    const { transport: scripted } = scriptedTransport([
      { match: "/suche", body: ps.readFixtureText("payloads", "parlamentsspiegel-thueringen.html") },
      { match: "Fulltext/Search", body: "<html>error</html>" },
    ]);
    const result = await new ThueringenSource().discover({
      engine: testEngine(scripted),
      state: { source: "thueringen", http_cache: {} },
    });
    ok(result.refs.length >= 1);
    ok(result.warnings.some((warning) => warning.includes("a form this adapter does not know")));
  });
});
