// Bayern, driven against a recorded slice of the Landtag's own Anfragen feed.
//
// The slice deliberately keeps the three Sammeldrucksachen that carry the Anfragen
// zum Plenum — 19/12540, 19/12945 and 19/13141, three items each — because telling
// those apart from a Schriftliche Anfrage is the whole problem this adapter solves.

import { deepStrictEqual, match, ok, rejects, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BAYERN_LATEST_PERIOD,
  BayernFeedSource,
  byReference,
  createSource,
  drucksacheUrl,
  parseFeed,
  toRef,
} from "../src/index.js";
import { scriptedTransport, testEngine, fixtures } from "@maschinenlesbar.org/openka-lib-testing";
import { UsageError } from "@maschinenlesbar.org/openka-lib-errors";

const { readFixtureText } = fixtures(import.meta.url);
const FEED = readFixtureText("payloads", "rss-anfragen.xml");
const state = { source: "bayern", http_cache: {} };

/** The Landtag files a Schriftliche Anfrage; an Anfrage zum Plenum 404s. */
const SAMMELDRUCKSACHEN = ["12540", "12945", "13141"];
function landtag(): ReturnType<typeof scriptedTransport> {
  const routes = [{ match: "rssfeed.xhtml", body: FEED }];
  for (const number of SAMMELDRUCKSACHEN) {
    routes.push({ match: `19_00${number}.pdf`, body: "", status: 404 } as (typeof routes)[number]);
  }
  routes.push({ match: ".pdf", body: "%PDF-1.7" });
  return scriptedTransport(routes);
}

describe("the Anfragen feed", () => {
  it("takes the Drucksachennummer out of the item title", () => {
    const items = parseFeed(FEED);
    ok(items.length >= 19);
    for (const item of items) match(item.reference, /^19\/\d+$/);
    ok(items.every((item) => item.subject !== ""));
  });

  it("collapses a Sammeldrucksache to one candidate", () => {
    // An Anfrage zum Plenum contributes one item per question, ~50 of them, all
    // under the same Drucksachennummer. Left alone they would collide into one
    // record, because a record's id derives from its reference.
    const items = parseFeed(FEED);
    const unique = byReference(items);
    ok(items.length > unique.length);
    strictEqual(unique.length, new Set(items.map((item) => item.reference)).size);
  });

  it("ignores an item with no Drucksachennummer", () => {
    strictEqual(parseFeed("<rss><item><title>Kein Aktenzeichen</title></item></rss>").length, 0);
  });
});

describe("where the Landtag files a Drucksache", () => {
  it("pads the number to seven digits under the instrument's folder", () => {
    strictEqual(
      drucksacheUrl(19, "13327"),
      "https://www.bayern.landtag.de/www/ElanTextAblage_WP19/Drucksachen/Schriftliche%20Anfragen/19_0013327.pdf",
    );
  });
});

describe("Bayern source", () => {
  it("keeps the Schriftliche Anfragen and drops the Anfragen zum Plenum", async () => {
    const { transport } = landtag();
    const result = await new BayernFeedSource().discover({ engine: testEngine(transport), state });
    const refs = result.refs.map((ref) => ref.reference);
    // The three Sammeldrucksachen are not filed under "Schriftliche Anfragen", so
    // the Landtag answers 404 for them — which is the test, not a guess.
    for (const number of SAMMELDRUCKSACHEN) ok(!refs.includes(`19/${number}`), `19/${number} should be dropped`);
    strictEqual(refs.length, 10);
    strictEqual(new Set(refs).size, refs.length);
  });

  it("asks the Landtag once per distinct Drucksachennummer", async () => {
    const { transport, requests } = landtag();
    await new BayernFeedSource().discover({ engine: testEngine(transport), state });
    const heads = requests.filter((request) => request.method === "HEAD");
    strictEqual(heads.length, 13);
    strictEqual(new Set(heads.map((request) => request.url)).size, 13);
  });

  it("archives the static file, not the Vorgangsmappe the feed links", async () => {
    // The feed's link returns a dossier generated per request, with a `Stand:`
    // timestamp, so its bytes differ every time. The static Drucksache does not.
    const { transport } = landtag();
    const result = await new BayernFeedSource().discover({ engine: testEngine(transport), state });
    for (const ref of result.refs) {
      const document = ref.documents[0];
      match(document?.url ?? "", /\/Drucksachen\/Schriftliche%20Anfragen\/19_\d{7}\.pdf$/);
      strictEqual(document?.role, "combined_pdf");
      strictEqual(document?.urlStable, true);
    }
  });

  it("calls it a Schriftliche Anfrage, which is Bayern's instrument", async () => {
    const { transport } = landtag();
    const result = await new BayernFeedSource().discover({ engine: testEngine(transport), state });
    ok(result.refs.every((ref) => ref.documentType === "schriftliche_anfrage"));
  });

  it("claims no dates, because the feed's are not the document's", () => {
    // `pubDate` is when the entry appeared, not when the Anfrage was submitted or
    // answered. Both are in the document header, and the extractor reads them there.
    const [item] = parseFeed(FEED);
    ok(item?.published !== undefined);
    deepStrictEqual(toRef(item!, "https://x.invalid/a.pdf").dates, {});
  });

  it("refuses a date window rather than ignoring it", async () => {
    // The feed carries no dates and the refs claim none, so a window could not be
    // applied even after the fact. It used to return everything the feed held and
    // say nothing — exactly the dropped constraint the CLI is built to refuse.
    const { transport, requests } = landtag();
    await rejects(
      () => new BayernFeedSource().discover({ engine: testEngine(transport), state, since: "2026-09-01" }),
      UsageError,
    );
    await rejects(
      () => createSource().discover({ engine: testEngine(transport), state, until: "2026-09-07" }),
      UsageError,
    );
    // And neither the feed nor the aggregator was asked.
    strictEqual(requests.length, 0);
  });

  it("reports a non-RSS answer as unreadable, not as an empty Land", async () => {
    const { transport } = scriptedTransport([{ match: "rssfeed.xhtml", body: "<html>Wartung</html>" }]);
    const result = await new BayernFeedSource().discover({ engine: testEngine(transport), state });
    deepStrictEqual(result.refs, []);
    ok(result.unreadable?.includes("RSS"));
  });

  it("defaults to the Wahlperiode currently sitting", () => {
    strictEqual(BAYERN_LATEST_PERIOD, 19);
  });
});

describe("what createSource returns", () => {
  it("is the Landtag's own feed, with the aggregator only behind it", async () => {
    const { transport, requests } = landtag();
    const result = await createSource().discover({ engine: testEngine(transport), state });
    strictEqual(result.refs.length, 10);
    ok(!requests.some((request) => request.url.includes("parlamentsspiegel")));
  });
});
