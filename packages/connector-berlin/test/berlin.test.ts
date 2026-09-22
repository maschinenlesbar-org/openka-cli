// The Berlin connector: one XML export per Wahlperiode, fetched conditionally.

import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { BerlinSource, berlinFeedUrl, BERLIN_LATEST_PERIOD } from "../src/index.js";
import { scriptedTransport, testEngine, fixturesOf } from "@maschinenlesbar.org/openka-lib-testing";

// The recorded export is the PARDOK format's reference fixture; Berlin borrows it
// rather than keeping a second copy of the same bytes.
const { readFixtureText } = fixturesOf("@maschinenlesbar.org/openka-lib-pardok", import.meta.url);

describe("Berlin source", () => {
  const xml = readFixtureText("payloads", "pardok-sample.xml");

  it("builds the open-data URL for a Wahlperiode", () => {
    strictEqual(berlinFeedUrl(19), "https://www.parlament-berlin.de/opendata/pardok-wp19.xml");
  });

  it("discovers Anfragen and records the cache validators", async () => {
    const { transport } = scriptedTransport([
      { match: "pardok-wp19.xml", body: xml, headers: { etag: '"abc"', "last-modified": "Mon, 21 Sep 2026 12:00:00 GMT" } },
    ]);
    const result = await new BerlinSource().discover({
      engine: testEngine(transport),
      state: { source: "berlin", http_cache: {} },
    });
    ok(result.refs.length >= 1);
    const cached = result.state?.http_cache[berlinFeedUrl(BERLIN_LATEST_PERIOD)];
    strictEqual(cached?.etag, '"abc"');
  });

  it("reports an unchanged feed without re-parsing it", async () => {
    const { transport, requests } = scriptedTransport([{ match: "pardok-wp19.xml", status: 304 }]);
    const result = await new BerlinSource().discover({
      engine: testEngine(transport),
      state: { source: "berlin", http_cache: { [berlinFeedUrl(19)]: { etag: '"abc"' } } },
    });
    strictEqual(result.unchanged, true);
    deepStrictEqual(result.refs, []);
    strictEqual(requests[0]?.headers?.["if-none-match"], '"abc"');
  });

  it("re-reads the feed when the caller forces it", async () => {
    const { transport, requests } = scriptedTransport([{ match: "pardok-wp19.xml", body: xml }]);
    await new BerlinSource().discover({
      engine: testEngine(transport),
      state: { source: "berlin", http_cache: { [berlinFeedUrl(19)]: { etag: '"abc"' } } },
      force: true,
    });
    strictEqual(requests[0]?.headers?.["if-none-match"], undefined);
  });

  it("refuses a Wahlperiode the feed does not cover", async () => {
    const { transport } = scriptedTransport([{ match: "pardok", body: xml }]);
    await rejects(
      () => new BerlinSource().discover({ engine: testEngine(transport), state: { source: "berlin", http_cache: {} }, period: 42 }),
      /covers Wahlperioden/,
    );
  });

  it("refuses a response that is not an export rather than reporting zero results", async () => {
    const { transport } = scriptedTransport([{ match: "pardok", body: "<html>Wartungsarbeiten</html>" }]);
    await rejects(
      () => new BerlinSource().discover({ engine: testEngine(transport), state: { source: "berlin", http_cache: {} } }),
      /did not return a Parlamentsspiegel export/,
    );
  });
});
