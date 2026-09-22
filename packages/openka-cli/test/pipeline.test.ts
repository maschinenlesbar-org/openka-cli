// The pipeline, reproducibility verification and the golden fixtures — the parts
// that carry the "same input, same bytes, forever" claim.

import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isoInstant, sync } from "@maschinenlesbar.org/openka-lib-pipeline";
import { verifyRecord, diffPaths } from "@maschinenlesbar.org/openka-lib-verify";
import { canonicalJsonLine } from "@maschinenlesbar.org/openka-lib-repro";
import { listAllGoldens, verifyGolden } from "@maschinenlesbar.org/openka-cli-ka-factory";
import { BerlinSource, berlinFeedUrl } from "@maschinenlesbar.org/openka-connector-berlin";
import type { DiscoverOptions, DiscoverResult, Source } from "@maschinenlesbar.org/openka-lib-source";
import type { Asker } from "@maschinenlesbar.org/openka-lib-models";
import { MemoryStore, PROJECT_ROOT, scriptedTransport, testEngine, fixturesOf } from "@maschinenlesbar.org/openka-lib-testing";

// Real documents come from the connector that recorded them, and the PARDOK export
// from the package that parses it: one copy of each, borrowed explicitly.
const { readFixture } = fixturesOf("@maschinenlesbar.org/openka-connector-berlin", import.meta.url);
const { readFixtureText } = fixturesOf("@maschinenlesbar.org/openka-lib-pardok", import.meta.url);

const PDF_URL = "https://pardok.parlament-berlin.de/starweb/adis/citat/VT/19/SchrAnfr/S19-10006.pdf";
const PDF = readFixture(
  "berlin",
  "berlin-19-10006",
  "7d0515afe6e596c8913c4353b6b89dbbb4da5c5ae4092a2cecb2a8660bf774ad.bin",
);

/** A source with one hard-coded ref, so the pipeline is tested without a parliament. */
class StubSource implements Source {
  readonly key = "berlin";
  readonly parliament = "berlin" as const;
  readonly tier = "structured" as const;
  readonly label = "stub";
  readonly homepage = "https://example.invalid";
  readonly notes = "test double";
  discoveries = 0;

  constructor(private readonly overrides: { title?: string; askers?: Asker[]; ministry?: string } = {}) {}

  async discover(_options: DiscoverOptions): Promise<DiscoverResult> {
    this.discoveries++;
    return {
      warnings: [],
      refs: [
        {
          key: "V-1",
          reference: "19/10006",
          legislative_period: 19,
          title: this.overrides.title ?? "Wann kommen die Solaranlagen nach Pankow?",
          documentType: "schriftliche_anfrage",
          askers: this.overrides.askers ?? [{ name: "Andreas Otto", party: "Grüne" }],
          answered_by: this.overrides.ministry === undefined ? {} : { ministry: this.overrides.ministry },
          dates: { submitted: "2021-11-04", answered: "2021-11-12" },
          documents: [{ role: "combined_pdf", url: PDF_URL, urlStable: true }],
        },
      ],
    };
  }
}

describe("sync pipeline", () => {
  it("fetches, extracts, stores and indexes", async () => {
    const store = new MemoryStore();
    const { transport } = scriptedTransport([{ match: ".pdf", body: PDF }]);
    const report = await sync({
      source: new StubSource(),
      store,
      engine: testEngine(transport),
      now: () => new Date("2026-01-02T03:04:05Z"),
    });
    strictEqual(report.discovered, 1);
    strictEqual(report.stored, 1);
    strictEqual(report.failed, 0);
    const record = store.getRecord("berlin-19-10006");
    strictEqual(record?.qa.length, 6);
    strictEqual(record?.source_documents[0]?.retrieved_at, "2026-01-02T03:04:05Z");
    strictEqual(store.catalogEntry("berlin-19-10006")?.parliament, "berlin");
  });

  it("is idempotent: a second run over unchanged inputs stores nothing", async () => {
    const store = new MemoryStore();
    const { transport } = scriptedTransport([{ match: ".pdf", body: PDF, headers: { etag: '"v1"' } }]);
    const source = new StubSource();
    const options = { source, store, engine: testEngine(transport), now: () => new Date("2026-01-02T03:04:05Z") };
    await sync(options);
    const first = store.getRecordBytes("berlin-19-10006");
    const second = await sync(options);
    strictEqual(second.stored, 0);
    strictEqual(second.unchanged, 1);
    deepStrictEqual(store.getRecordBytes("berlin-19-10006"), first);
  });

  it("re-extracts when the source metadata changed", async () => {
    const store = new MemoryStore();
    const { transport } = scriptedTransport([{ match: ".pdf", body: PDF }]);
    const engine = testEngine(transport);
    await sync({ source: new StubSource(), store, engine, now: () => new Date("2026-01-02T03:04:05Z") });
    const report = await sync({
      source: new StubSource({ title: "Ein korrigierter Titel" }),
      store,
      engine,
      now: () => new Date("2026-01-02T03:04:05Z"),
    });
    strictEqual(report.stored, 1);
    strictEqual(store.getRecord("berlin-19-10006")?.title, "Ein korrigierter Titel");
  });

  it("re-extracts when upstream corrects an asker", async () => {
    // The sync used to compare only the title and the dates, so a Landtag
    // correcting a misattributed MP was reported as "unchanged" and the wrong
    // name stayed in the corpus indefinitely.
    const store = new MemoryStore();
    const { transport } = scriptedTransport([{ match: ".pdf", body: PDF }]);
    const engine = testEngine(transport);
    const now = () => new Date("2026-01-02T03:04:05Z");
    await sync({ source: new StubSource(), store, engine, now });
    const report = await sync({
      source: new StubSource({ askers: [{ name: "Berta Richtig", party: "CDU" }] }),
      store,
      engine,
      now,
    });
    strictEqual(report.stored, 1);
    strictEqual(store.getRecord("berlin-19-10006")?.askers[0]?.name, "Berta Richtig");
  });

  it("re-extracts when upstream corrects the answering ministry", async () => {
    const store = new MemoryStore();
    const { transport } = scriptedTransport([{ match: ".pdf", body: PDF }]);
    const engine = testEngine(transport);
    const now = () => new Date("2026-01-02T03:04:05Z");
    await sync({ source: new StubSource({ ministry: "Ministerium A" }), store, engine, now });
    const report = await sync({ source: new StubSource({ ministry: "Ministerium B" }), store, engine, now });
    strictEqual(report.stored, 1);
    strictEqual(store.getRecord("berlin-19-10006")?.answered_by.ministry, "Ministerium B");
  });

  it("does not churn when a ministry was derived from the document, not stated", async () => {
    // `findMinistry` fills in what the source left out. Comparing the stored value
    // against the source's silence would rewrite every record on every run.
    const store = new MemoryStore();
    const { transport } = scriptedTransport([{ match: ".pdf", body: PDF }]);
    const engine = testEngine(transport);
    const now = () => new Date("2026-01-02T03:04:05Z");
    await sync({ source: new StubSource(), store, engine, now });
    const second = await sync({ source: new StubSource(), store, engine, now });
    strictEqual(second.stored, 0);
    strictEqual(second.unchanged, 1);
  });

  it("re-uses the archived bytes when the upstream answers 304", async () => {
    const store = new MemoryStore();
    let conditional = 0;
    const engine = testEngine(async (request) => {
      if (request.headers?.["if-none-match"] !== undefined) {
        conditional++;
        return { status: 304, headers: {}, body: Buffer.alloc(0) };
      }
      return { status: 200, headers: { etag: '"pdf-v1"' }, body: PDF };
    });
    const source = new StubSource();
    await sync({ source, store, engine, now: () => new Date("2026-01-02T03:04:05Z") });
    await sync({ source, store, engine, force: true, now: () => new Date("2026-01-02T03:04:05Z") });
    strictEqual(conditional, 1);
    ok(store.getRecord("berlin-19-10006") !== undefined);
  });

  it("stores a metadata-only record with its holes named", async () => {
    const store = new MemoryStore();
    const { transport } = scriptedTransport([{ match: ".pdf", body: PDF }]);
    await sync({
      source: new StubSource(),
      store,
      engine: testEngine(transport),
      metadataOnly: true,
      now: () => new Date("2026-01-02T03:04:05Z"),
    });
    const record = store.getRecord("berlin-19-10006");
    strictEqual(record?.qa.length, 0);
    ok(record?.extraction.abstained_fields.includes("qa"));
    strictEqual(record?.extraction.review_status, "needs_review");
  });

  it("records a discovery failure in the source state instead of throwing", async () => {
    const store = new MemoryStore();
    const failing: Source = {
      key: "berlin",
      parliament: "berlin",
      tier: "structured",
      label: "failing",
      homepage: "https://example.invalid",
      notes: "",
      discover: async () => {
        throw new Error("upstream is down");
      },
    };
    const { transport } = scriptedTransport([{ match: "x", body: "" }]);
    const report = await sync({ source: failing, store, engine: testEngine(transport) });
    deepStrictEqual(report.errors, ["upstream is down"]);
    strictEqual(store.getSourceState("berlin").last_error, "upstream is down");
    strictEqual(store.getSourceState("berlin").last_success, undefined);
  });

  it("reports an unchanged upstream without doing any work", async () => {
    const store = new MemoryStore();
    const xml = readFixtureText("payloads", "pardok-sample.xml");
    const { transport } = scriptedTransport([{ match: "pardok", status: 304 }]);
    const report = await sync({
      source: new BerlinSource(),
      store,
      engine: testEngine(transport),
    });
    strictEqual(report.upstreamUnchanged, true);
    strictEqual(report.stored, 0);
    ok(xml.length > 0);
  });

  it("carries the per-document cache validators into the next run", async () => {
    const store = new MemoryStore();
    const { transport } = scriptedTransport([{ match: ".pdf", body: PDF, headers: { etag: '"pdf-v1"' } }]);
    await sync({ source: new StubSource(), store, engine: testEngine(transport), now: () => new Date("2026-01-02T03:04:05Z") });
    strictEqual(store.getSourceState("berlin").http_cache[PDF_URL]?.etag, '"pdf-v1"');
  });

  it("formats an instant to second precision", () => {
    strictEqual(isoInstant(new Date("2026-01-02T03:04:05.678Z")), "2026-01-02T03:04:05Z");
  });
});

describe("ka verify", () => {
  async function seeded(): Promise<MemoryStore> {
    const store = new MemoryStore();
    const { transport } = scriptedTransport([{ match: ".pdf", body: PDF }]);
    await sync({ source: new StubSource(), store, engine: testEngine(transport), now: () => new Date("2026-01-02T03:04:05Z") });
    return store;
  }

  it("reproduces a record byte for byte", async () => {
    const store = await seeded();
    const result = await verifyRecord("berlin-19-10006", { store, env: {} });
    strictEqual(result.ok, true, result.reason ?? "");
    deepStrictEqual(result.differences, []);
  });

  it("reports a record that is not there", async () => {
    const result = await verifyRecord("nope", { store: new MemoryStore(), env: {} });
    strictEqual(result.ok, false);
    strictEqual(result.reason, "no such record");
  });

  it("says it cannot check rather than claiming a mismatch when the bytes are gone", async () => {
    const store = await seeded();
    const record = store.getRecord("berlin-19-10006");
    ok(record !== undefined);
    const stripped = { ...record, source_documents: [{ ...record.source_documents[0], sha256: "0".repeat(64) }] };
    store.putRecord(stripped as never);
    const result = await verifyRecord("berlin-19-10006", { store, env: {} });
    strictEqual(result.ok, false);
    match(result.reason ?? "", /archived bytes .* are missing/);
  });

  it("detects a tampered record and names the field", async () => {
    const store = await seeded();
    const record = store.getRecord("berlin-19-10006");
    ok(record !== undefined);
    record.qa[0] = { ...record.qa[0], answer: "Eine erfundene Antwort." } as never;
    store.putRecord(record);
    const result = await verifyRecord("berlin-19-10006", { store, env: {} });
    strictEqual(result.ok, false);
    ok(result.differences.includes("qa[0].answer"));
  });

  it("does not turn a human review decision into a verification failure", async () => {
    // A record that genuinely abstains, then marked verified by a person: the
    // re-extraction still abstains, and the only field that differs is the review
    // status the human set. That must not be reported as a reproducibility failure.
    const store = new MemoryStore();
    const golden = listAllGoldens(PROJECT_ROOT).find((candidate) =>
      candidate.record.extraction.abstained_fields.includes("qa"),
    );
    ok(golden !== undefined);
    for (const document of golden.record.source_documents) {
      if (document.sha256 === undefined) continue;
      store.putBlob(readFileSync(join(golden.dir, `${document.sha256}.bin`)));
    }
    store.putRecord({ ...golden.record, extraction: { ...golden.record.extraction, review_status: "human_verified" } });
    const result = await verifyRecord(golden.meta.id, { store, env: {} });
    strictEqual(result.ok, true, `${result.reason} ${result.differences.join(", ")}`);
  });

  it("names every differing path", () => {
    deepStrictEqual(diffPaths({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 3 } }), ["b.c"]);
    deepStrictEqual(diffPaths([1, 2], [1, 3]), ["[1]"]);
  });
});

describe("golden fixtures", () => {
  it("ships goldens for every source kind and for an honest failure", () => {
    const goldens = listAllGoldens(PROJECT_ROOT);
    const parliaments = new Set(goldens.map((golden) => golden.record.parliament));
    // One per source kind: a structured XML feed (Berlin), a JSON API (Bundestag),
    // a dedicated Land adapter (NRW) and the aggregator (Baden-Württemberg).
    ok(parliaments.has("berlin"));
    ok(parliaments.has("bund"));
    ok(parliaments.has("nordrhein-westfalen"));
    ok(parliaments.has("baden-wuerttemberg"));
    ok(goldens.some((golden) => golden.record.qa.length >= 6));
    // A document no rule set can read. Pinning the abstention means a future rule
    // that starts reading it shows up as a visible, reviewable change — which is
    // exactly what happened to the two Bundestag goldens when the grouped-answer
    // rule landed.
    ok(goldens.some((golden) => golden.record.extraction.abstained_fields.includes("qa")));
  });

  it("every golden re-extracts to exactly its frozen record", async () => {
    for (const golden of listAllGoldens(PROJECT_ROOT)) {
      const result = await verifyGolden(golden);
      strictEqual(result.ok, true, `${golden.meta.id}: ${result.reason} ${result.differences.join(", ")}`);
    }
  });

  it("stores goldens in canonical form", () => {
    for (const golden of listAllGoldens(PROJECT_ROOT)) {
      strictEqual(canonicalJsonLine(golden.record), canonicalJsonLine(JSON.parse(JSON.stringify(golden.record))));
    }
  });

  it("notices when a document-derived field no longer matches", async () => {
    // The title comes from the source feed, not from the PDF, so changing it moves
    // the input and the expectation together. A question's text does not: it is
    // what the extractor produced, and changing it must be caught.
    const golden = listAllGoldens(PROJECT_ROOT).find((candidate) => candidate.record.qa.length > 0);
    ok(golden !== undefined);
    const qa = golden.record.qa.map((pair, index) => (index === 0 ? { ...pair, answer: "erfunden" } : pair));
    const result = await verifyGolden({ ...golden, record: { ...golden.record, qa } });
    strictEqual(result.ok, false);
    ok(result.differences.includes("qa[0].answer"));
  });
});

describe("Berlin feed URL", () => {
  it("names a file per Wahlperiode", () => {
    match(berlinFeedUrl(18), /pardok-wp18\.xml$/);
  });
});
