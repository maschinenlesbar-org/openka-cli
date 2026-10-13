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
import { scriptedTransport, testEngine, fixtures, fixturesOf } from "@maschinenlesbar.org/openka-lib-testing";
import { UsageError } from "@maschinenlesbar.org/openka-lib-errors";

const { readFixtureText } = fixtures(import.meta.url);
const FEED = readFixtureText("payloads", "rss-anfragen.xml");
const PORTAL = fixturesOf("@maschinenlesbar.org/openka-lib-parlamentsspiegel", import.meta.url).readFixtureText(
  "payloads",
  "parlamentsspiegel-bayern.html",
);
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

  it("reads items whose tags carry attributes or are upper case", () => {
    // Legal RSS the old pattern missed: every item dropped, "0 discovered", no warning
    // (exploratory 2026-10-13, B04-2).
    const items = parseFeed(
      '<rss><channel><item xml:lang="de"><title type="text">Initiativdrucksache 19/6524</title>' +
        "<description>a</description></item><ITEM><TITLE>Initiativdrucksache 19/12032</TITLE></ITEM></channel></rss>",
    );
    deepStrictEqual(
      items.map((item) => [item.reference, item.subject]),
      [
        ["19/6524", "a"],
        ["19/12032", ""],
      ],
    );
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

  it("refuses a date window on its own rather than ignoring it", async () => {
    // The feed carries no dates and the refs claim none, so a window could not be
    // applied even after the fact. It used to return everything the feed held and
    // say nothing — exactly the dropped constraint the CLI is built to refuse.
    // `createSource()` answers a window from the Parlamentsspiegel instead (below).
    const { transport, requests } = landtag();
    await rejects(
      () => new BayernFeedSource().discover({ engine: testEngine(transport), state, since: "2026-09-01" }),
      UsageError,
    );
    strictEqual(requests.length, 0);
  });

  it("reports a non-RSS answer as unreadable, not as an empty Land", async () => {
    const { transport } = scriptedTransport([{ match: "rssfeed.xhtml", body: "<html>Wartung</html>" }]);
    const result = await new BayernFeedSource().discover({ engine: testEngine(transport), state });
    deepStrictEqual(result.refs, []);
    ok(result.unreadable?.includes("RSS"));
  });

  it("reports a feed without a single item as unreadable, not as a quiet week", async () => {
    // The Landtag's "Drucksachen von Anfragen" always lists the newest weeks; an RSS
    // channel with no item is a feed that broke, and read as an answer it was a
    // silent `0 discovered` with no fallback (exploratory 2026-10-13, B02-1).
    const { transport } = scriptedTransport([
      { match: "rssfeed.xhtml", body: '<?xml version="1.0"?><rss version="2.0"><channel><title>x</title></channel></rss>' },
    ]);
    const result = await new BayernFeedSource().discover({ engine: testEngine(transport), state });
    deepStrictEqual(result.refs, []);
    match(result.unreadable ?? "", /no item/);
  });

  it("reports a feed that came truncated as unreadable", async () => {
    // Cut mid-item, it used to yield the items before the cut and say nothing.
    const cut = FEED.slice(0, FEED.indexOf("<item>", FEED.indexOf("<item>") + 1) + 40);
    const { transport } = scriptedTransport([{ match: "rssfeed.xhtml", body: cut }]);
    const result = await new BayernFeedSource().discover({ engine: testEngine(transport), state });
    deepStrictEqual(result.refs, []);
    match(result.unreadable ?? "", /truncated/);
  });

  it("reports items it cannot read as unreadable, not as nothing new", async () => {
    // The feed's format changed under the parser: items there, no reference read.
    const body = "<rss><channel><item><title>Drucksache Nr. ? vom heute</title></item></channel></rss>";
    const { transport } = scriptedTransport([{ match: "rssfeed.xhtml", body }]);
    const result = await new BayernFeedSource().discover({ engine: testEngine(transport), state });
    deepStrictEqual(result.refs, []);
    match(result.unreadable ?? "", /1 item.*no Drucksachennummer/);
  });

  it("defaults to the newest Wahlperiode the feed lists", async () => {
    // The default was the constant 19: after the next Landtag election a feed of
    // Wahlperiode-20 Drucksachen synced to "0 discovered", silently
    // (exploratory 2026-10-13, B04-1).
    strictEqual(BAYERN_LATEST_PERIOD, 19);
    const body =
      "<rss><channel>" +
      ["20/15", "20/16", "19/13999"].map((reference) => `<item><title>Initiativdrucksache ${reference}</title></item>`).join("") +
      "</channel></rss>";
    const { transport, requests } = scriptedTransport([
      { match: "rssfeed.xhtml", body },
      { match: ".pdf", body: "%PDF-1.7" },
    ]);
    const result = await new BayernFeedSource().discover({ engine: testEngine(transport), state });
    deepStrictEqual(
      result.refs.map((ref) => ref.reference),
      ["20/15", "20/16"],
    );
    ok(requests.some((request) => request.url.endsWith("/ElanTextAblage_WP20/Drucksachen/Schriftliche%20Anfragen/20_0000015.pdf")));
    // The older period's leftovers are named, with the way to them.
    ok(result.warnings.some((warning) => warning.includes("1 Drucksache") && warning.includes("--period 19")));
  });
});

describe("a probe the Landtag does not answer with 200 or 404", () => {
  /** The recorded feed, with the file of 19/13327 answering `status` instead. */
  function landtagRefusing(status: number): ReturnType<typeof scriptedTransport> {
    const routes = [{ match: "rssfeed.xhtml", body: FEED }, { match: "19_0013327.pdf", body: "", status }];
    for (const number of SAMMELDRUCKSACHEN) routes.push({ match: `19_00${number}.pdf`, body: "", status: 404 });
    routes.push({ match: ".pdf", body: "%PDF-1.7" });
    return scriptedTransport(routes);
  }

  it("skips that one Drucksache and keeps every other", async () => {
    // One refused HEAD among ~400 used to throw out of discovery, and the run fell
    // back to the Parlamentsspiegel — dropping every Anfrage the feed had found,
    // unnamed (exploratory 2026-10-13, B03-1).
    for (const status of [403, 405, 410, 500]) {
      const { transport, requests } = landtagRefusing(status);
      const result = await createSource().discover({ engine: testEngine(transport, { maxRetries: 0 }), state });
      const refs = result.refs.map((ref) => ref.reference);
      strictEqual(refs.length, 9, `status ${status}`);
      ok(!refs.includes("19/13327"));
      ok(result.warnings.some((warning) => warning.includes("19/13327") && warning.includes(String(status))));
      ok(!requests.some((request) => request.url.includes("parlamentsspiegel")));
    }
  });

  it("is a feed that cannot be read when no probe is answered at all", async () => {
    const { transport } = scriptedTransport([
      { match: "rssfeed.xhtml", body: FEED },
      { match: ".pdf", body: "", status: 503 },
    ]);
    const result = await new BayernFeedSource().discover({ engine: testEngine(transport, { maxRetries: 0 }), state });
    deepStrictEqual(result.refs, []);
    match(result.unreadable ?? "", /could be checked/);
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

describe("a Wahlperiode the feed does not list", () => {
  it("is refused with the way to it, not synced to an empty run", async () => {
    // `--period 18` filtered every feed item out: exit 0, "0 discovered", an empty
    // stderr — indistinguishable from "Bayern had no Anfragen in WP 18"
    // (exploratory 2026-10-13, B01-1). The Parlamentsspiegel cannot search by period,
    // only by date, so the way to WP 18 is a window.
    for (const discover of [
      (options: Parameters<BayernFeedSource["discover"]>[0]) => new BayernFeedSource().discover(options),
      (options: Parameters<BayernFeedSource["discover"]>[0]) => createSource().discover(options),
    ]) {
      const { transport } = landtag();
      await rejects(discover({ engine: testEngine(transport), state, period: 18 }), (err: Error) => {
        ok(err instanceof UsageError);
        match(err.message, /Wahlperiode 18/);
        match(err.message, /lists only Wahlperiode 19/);
        match(err.message, /--since\/--until/);
        return true;
      });
    }
  });

  it("is taken as usual when the feed lists it", async () => {
    const { transport } = landtag();
    const result = await new BayernFeedSource().discover({ engine: testEngine(transport), state, period: 19 });
    strictEqual(result.refs.length, 10);
  });
});

describe("a date window", () => {
  // The feed holds only the newest weeks and carries no dates, so a window used to
  // be refused — and Bayern's history was out of reach, though the Parlamentsspiegel
  // lists it and links the same static Drucksachen (exploratory 2026-10-13, B01-2).
  function portal(): ReturnType<typeof scriptedTransport> {
    return scriptedTransport([
      { match: /parlamentsspiegel\.de\/suche\?.*page=0/, body: PORTAL },
      { match: "parlamentsspiegel.de/suche", body: "<html></html>" },
    ]);
  }

  it("is answered from the Parlamentsspiegel's Bayern rows, not refused", async () => {
    const { transport, requests } = portal();
    const result = await createSource().discover({ engine: testEngine(transport), state, since: "2026-09-01", until: "2026-09-30" });
    deepStrictEqual(
      result.refs.map((ref) => ref.reference).sort(),
      ["19/13227", "19/13262", "19/13269"],
    );
    const search = new URL(requests[0]?.url ?? "");
    strictEqual(search.searchParams.get("qyHerk"), "BAY");
    strictEqual(search.searchParams.get("qyZeitAb"), "01.09.2026");
    strictEqual(search.searchParams.get("qyZeitBis"), "30.09.2026");
    // The feed is not asked: it could not answer a window.
    ok(!requests.some((request) => request.url.includes("rssfeed")));
    for (const ref of result.refs) match(ref.documents[0]?.url ?? "", /\/ElanTextAblage_WP19\/Drucksachen\/Schriftliche/);
    ok(result.warnings.some((warning) => warning.includes("Parlamentsspiegel")));
  });

  it("keeps a period given beside it", async () => {
    const { transport } = portal();
    const result = await createSource().discover({ engine: testEngine(transport), state, since: "2026-09-01", period: 18 });
    deepStrictEqual(result.refs, []);
  });
});
