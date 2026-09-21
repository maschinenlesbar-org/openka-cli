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
  unwrap,
} from "../src/sources/thueringen.js";
import { sourceEntry } from "../src/sources/registry.js";
import { readFixtureText, scriptedTransport, testEngine } from "./helpers.js";

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
    const data = unwrap(SEARCH);
    ok(data !== undefined);
    strictEqual(typeof data["queryid"], "number");
  });

  it("treats anything but the success shape as nothing", () => {
    strictEqual(unwrap("not json"), undefined);
    strictEqual(unwrap('{"success":false,"data":"{}"}'), undefined);
    strictEqual(unwrap('{"success":true,"data":{"already":"an object"}}'), undefined);
    strictEqual(unwrap('{"success":true,"data":"not json either"}'), undefined);
  });

  it("reads the first hit and its query id", () => {
    const hit = firstHit(SEARCH);
    strictEqual(hit?.id, 102282);
    strictEqual(hit?.queryId, 366775);
  });

  it("finds the answer among the Vorgang's positions", () => {
    const answer = answerPosition(PROCESS);
    // 8/979 is answered by 8/1715 — no relation between the numbers, which is why
    // the lookup exists at all.
    strictEqual(answer?.reference, "8/1715");
    match(answer?.url ?? "", new RegExp(`^${PARLDOK_WEB}/dokument/103169/`));
  });

  it("reports no answer rather than guessing when the shape is unfamiliar", () => {
    strictEqual(answerPosition('{"success":true,"data":"{\\"process\\":{\\"positions\\":[]}}"}'), undefined);
    strictEqual(firstHit('{"success":true,"data":"{\\"docs\\":[]}"}'), undefined);
  });
});

describe("Thüringen source", () => {
  function transport(): ReturnType<typeof scriptedTransport> {
    return scriptedTransport([
      { match: "/suche", body: readFixtureText("payloads", "parlamentsspiegel-thueringen.html") },
      { match: "Fulltext/Search", body: SEARCH },
      { match: "Process/Document", body: PROCESS },
    ]);
  }

  it("is registered as its own source", () => {
    strictEqual(sourceEntry("thueringen")?.status, "implemented");
  });

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
      { match: "/suche", body: readFixtureText("payloads", "parlamentsspiegel-thueringen.html") },
      { match: "Fulltext/Search", body: "<html>error</html>" },
    ]);
    const result = await new ThueringenSource().discover({
      engine: testEngine(scripted),
      state: { source: "thueringen", http_cache: {} },
    });
    ok(result.refs.length >= 1);
    ok(result.warnings.some((warning) => warning.includes("no Kleine Anfrage with that number")));
  });
});
