// sachsen-anhalt: the documents are public and the server's robots.txt disallows everyone.
// These tests pin down that the default is to fetch nothing, that the override is
// explicit, and that either way the operator is told which happened.

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { SachsenAnhaltSource, DOCUMENT_ORIGIN, DOCUMENT_PATH, POLITE_INTERVAL_MS, createSource } from "../src/index.js";
import { scriptedTransport, testEngine, fixturesOf } from "@maschinenlesbar.org/openka-lib-testing";

const { readFixtureText } = fixturesOf("@maschinenlesbar.org/openka-lib-parlamentsspiegel", import.meta.url);
const RESULTS = readFixtureText("payloads", "parlamentsspiegel-results.html");
const DISALLOW_ALL = "User-agent: *\nDisallow: /\n";
const state = { source: "sachsen-anhalt", http_cache: {} };

function landtag(robots: string): ReturnType<typeof scriptedTransport> {
  return scriptedTransport([
    { match: "robots.txt", body: robots },
    { match: "/suche", body: RESULTS },
  ]);
}

describe("sachsen-anhalt source", () => {
  it("fetches nothing by default, and says why", async () => {
    const { transport, requests } = landtag(DISALLOW_ALL);
    const result = await new SachsenAnhaltSource().discover({ engine: testEngine(transport), state });
    deepStrictEqual(result.refs, []);
    ok(result.warnings[0]?.includes("robots.txt"));
    ok(result.warnings[0]?.includes("--ignore-robots"));
    // ...and it does not go on to search the aggregator for records it cannot use.
    ok(!requests.some((request) => request.url.includes("/suche")));
  });

  it("fetches when the operator overrides, and records that on the result", async () => {
    const { transport } = landtag(DISALLOW_ALL);
    const result = await new SachsenAnhaltSource().discover({
      engine: testEngine(transport),
      state,
      ignoreRobots: true,
    });
    ok(result.refs.length >= 1);
    // The override is never silent.
    ok(result.warnings[0]?.includes("--ignore-robots was given"));
    ok(result.warnings[0]?.includes("the operator's"));
  });

  it("needs no override once the Landtag lifts the rule", async () => {
    // robots.txt is read at run time, not baked in, so this corrects itself.
    const { transport } = landtag("User-agent: *\nDisallow: /files/\n");
    const result = await new SachsenAnhaltSource().discover({ engine: testEngine(transport), state });
    ok(result.refs.length >= 1);
    ok(!result.warnings.some((warning) => warning.includes("--ignore-robots")));
  });

  it("treats a missing robots.txt as permission", async () => {
    const { transport } = scriptedTransport([
      { match: "robots.txt", body: "", status: 404 },
      { match: "/suche", body: RESULTS },
    ]);
    const result = await new SachsenAnhaltSource().discover({ engine: testEngine(transport), state });
    ok(result.refs.length >= 1);
  });

  it("goes slowly when it does fetch", () => {
    // A server that asked not to be crawled gets the slowest rate on offer.
    strictEqual(new SachsenAnhaltSource().minHostIntervalMs, POLITE_INTERVAL_MS);
    ok(POLITE_INTERVAL_MS >= 4000);
  });

  it("asks the document server, not the aggregator, for permission", () => {
    ok(DOCUMENT_ORIGIN.startsWith("https://"));
    ok(DOCUMENT_PATH.startsWith("/"));
    ok(!DOCUMENT_ORIGIN.includes("parlamentsspiegel"));
  });
});

describe("what createSource returns", () => {
  it("is the gated source itself, not a fallback to the same aggregator", () => {
    // Discovery already runs through the Parlamentsspiegel here, so a FallbackSource
    // around it would retry the same request on failure and describe the source as
    // falling back to itself.
    const source = createSource();
    ok(!source.notes.includes("Falls back"));
    strictEqual(source.minHostIntervalMs, POLITE_INTERVAL_MS);
  });

  it("still honours the default without the flag", async () => {
    const { transport } = landtag(DISALLOW_ALL);
    const result = await createSource().discover({ engine: testEngine(transport), state });
    deepStrictEqual(result.refs, []);
  });
});
