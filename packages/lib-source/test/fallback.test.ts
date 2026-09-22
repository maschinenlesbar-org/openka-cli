// Composing a parliament's own interface with the aggregator behind it.
//
// The rule these tests pin down is the one that is easy to get wrong: an empty
// window is an answer, and must not be backfilled from somewhere else.

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { FallbackSource, type DiscoverOptions, type DiscoverResult, type Source } from "../src/index.js";

function source(key: string, discover: () => Promise<DiscoverResult>): Source {
  return {
    key,
    parliament: "thueringen",
    tier: "text_layer",
    label: `${key} label`,
    homepage: `https://${key}.invalid/`,
    notes: `${key} notes.`,
    discover,
  };
}

const ref = (reference: string): DiscoverResult["refs"][number] =>
  ({
    key: reference,
    reference,
    legislative_period: 8,
    title: "Titel",
    documentType: "kleine_anfrage",
    askers: [],
    answered_by: {},
    dates: {},
    documents: [],
  }) as DiscoverResult["refs"][number];

const options = {} as DiscoverOptions;

describe("FallbackSource", () => {
  it("uses the parliament's own interface and never calls the aggregator", async () => {
    let aggregatorCalls = 0;
    const composed = new FallbackSource(
      source("official", async () => ({ refs: [ref("8/1")], warnings: [] })),
      source("aggregator", async () => {
        aggregatorCalls += 1;
        return { refs: [ref("8/999")], warnings: [] };
      }),
    );
    const result = await composed.discover(options);
    deepStrictEqual(result.refs.map((r) => r.reference), ["8/1"]);
    strictEqual(aggregatorCalls, 0);
    deepStrictEqual(result.warnings, []);
  });

  it("does not fall back on an empty window", async () => {
    // A Land that published nothing in March published nothing in March. Filling
    // that in from the aggregator would turn "no Anfragen" into "some Anfragen",
    // which is the one thing a fallback must never do.
    let aggregatorCalls = 0;
    const composed = new FallbackSource(
      source("official", async () => ({ refs: [], warnings: [] })),
      source("aggregator", async () => {
        aggregatorCalls += 1;
        return { refs: [ref("8/999")], warnings: [] };
      }),
    );
    const result = await composed.discover(options);
    deepStrictEqual(result.refs, []);
    strictEqual(aggregatorCalls, 0);
  });

  it("falls back when the parliament's interface throws", async () => {
    const composed = new FallbackSource(
      source("official", async () => {
        throw new Error("getaddrinfo ENOTFOUND");
      }),
      source("aggregator", async () => ({ refs: [ref("8/999")], warnings: ["aggregator note"] })),
    );
    const result = await composed.discover(options);
    deepStrictEqual(result.refs.map((r) => r.reference), ["8/999"]);
    ok(result.warnings[0]?.includes("getaddrinfo ENOTFOUND"));
    ok(result.warnings[0]?.includes("came from the aggregator"));
    // The fallback's own warnings survive.
    ok(result.warnings.includes("aggregator note"));
  });

  it("falls back when the interface answered in a shape it could not read", async () => {
    const composed = new FallbackSource(
      source("official", async () => ({ refs: [], warnings: [], unreadable: "no results container in the response" })),
      source("aggregator", async () => ({ refs: [ref("8/999")], warnings: [] })),
    );
    const result = await composed.discover(options);
    deepStrictEqual(result.refs.map((r) => r.reference), ["8/999"]);
    ok(result.warnings[0]?.includes("no results container"));
  });

  it("presents the parliament's own identity, not the aggregator's", async () => {
    const composed = new FallbackSource(
      source("official", async () => ({ refs: [], warnings: [] })),
      source("aggregator", async () => ({ refs: [], warnings: [] })),
    );
    strictEqual(composed.key, "official");
    strictEqual(composed.parliament, "thueringen");
    strictEqual(composed.homepage, "https://official.invalid/");
    // ...and says out loud that there is something behind it.
    ok(composed.notes.includes("Falls back to aggregator label"));
  });
});
