// The pipeline, reproducibility verification and the golden fixtures — the parts
// that carry the "same input, same bytes, forever" claim.

import { deepStrictEqual, match, ok, rejects, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CATALOG_CHECKPOINT,
  SYNC_LIMIT_MIN,
  isoInstant,
  normalizeSyncWindow,
  DRY_RUN_SAMPLE,
  ESTIMATE_MIN_KNOWN,
  countSources,
  planLanes,
  planSync,
  sourceStatus,
  sync,
  syncSources,
  syncLimitProblem,
  syncPeriodProblem,
} from "@maschinenlesbar.org/openka-lib-pipeline";
import { PERIOD_RANGE } from "@maschinenlesbar.org/openka-lib-models";
import { verifyRecord, diffPaths } from "@maschinenlesbar.org/openka-lib-verify";
import { canonicalJsonLine } from "@maschinenlesbar.org/openka-lib-repro";
import { CorpusLockedError, OpenKaValidationError, UsageError } from "@maschinenlesbar.org/openka-lib-errors";
import type { Transport } from "@maschinenlesbar.org/openka-lib-http";
import { assertGoldensPass, listAllGoldens, verifyGolden, verifyGoldens } from "@maschinenlesbar.org/openka-cli-ka-factory";
import { BerlinSource, berlinFeedUrl } from "@maschinenlesbar.org/openka-connector-berlin";
import { drucksacheUrl, toRef } from "@maschinenlesbar.org/openka-connector-bayern";
import { search } from "@maschinenlesbar.org/openka-lib-search";
import type { DiscoverOptions, DiscoverResult, Source } from "@maschinenlesbar.org/openka-lib-source";
import type { Asker } from "@maschinenlesbar.org/openka-lib-models";
import { MemoryStore, PROJECT_ROOT, sampleRecord, scriptedTransport, testEngine, fixturesOf } from "@maschinenlesbar.org/openka-lib-testing";
import { FileStore, catalogGaps, indexRecord, markHumanVerified, reindexAll } from "@maschinenlesbar.org/openka-lib-store";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

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

/** `count` refs that all point at the same fixture PDF, for runs longer than one ref. */
class ManySource extends StubSource {
  constructor(private readonly refCount: number) {
    super();
  }

  override async discover(options: DiscoverOptions): Promise<DiscoverResult> {
    const one = (await super.discover(options)).refs[0];
    ok(one !== undefined);
    const refs = Array.from({ length: this.refCount }, (_, i) => ({
      ...one,
      key: `V-${i + 1}`,
      reference: `19/${10006 + i}`,
    }));
    return { warnings: [], refs };
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

  it("does not fetch a document its host's robots.txt disallows, and says so once", async () => {
    // The gated connectors check their own server, but the same PDF reaches the
    // pipeline through `--source parlamentsspiegel`. The rule has to hold at the
    // fetch, whichever source produced the URL.
    const store = new MemoryStore();
    const { transport, requests } = scriptedTransport([
      { match: "robots.txt", body: "User-agent: *\nDisallow: /\n" },
      { match: ".pdf", body: PDF },
    ]);
    const report = await sync({ source: new StubSource(), store, engine: testEngine(transport) });
    strictEqual(report.stored, 1);
    ok(!requests.some((request) => request.url.endsWith(".pdf")));
    strictEqual(report.warnings.filter((warning) => warning.includes("robots.txt")).length, 1);
    ok(report.warnings[0]?.includes("--ignore-robots"));
    // The record exists, with the hole named, rather than not at all.
    const record = store.getRecord("berlin-19-10006");
    deepStrictEqual(record?.source_documents, []);
    ok(record?.extraction.abstained_fields.includes("full_text"));
  });

  it("goes no faster than the source's politeness floor, whatever the engine was built with", async () => {
    // Brandenburg and Sachsen-Anhalt declare 4000 ms. The floor is part of the
    // Source contract, so sync() applies it, not only `ka sync`.
    class PoliteSource extends StubSource {
      readonly minHostIntervalMs = 4000;
    }
    const slept: number[] = [];
    let clock = 0;
    const { transport, requests } = scriptedTransport([
      { match: "robots.txt", status: 404, body: "" },
      { match: ".pdf", body: PDF },
    ]);
    const engine = testEngine(transport, {
      minHostIntervalMs: 100,
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
    });
    const report = await sync({ source: new PoliteSource(), store: new MemoryStore(), engine });
    strictEqual(report.stored, 1);
    // robots.txt and the PDF, on one host: one wait, at the source's floor.
    strictEqual(requests.length, 2);
    deepStrictEqual(slept, [4000]);
  });

  describe("a document that can no longer be fetched", () => {
    // First run: robots.txt allows everything and the PDF is served. Later runs:
    // the PDF answers 404, or robots.txt disallows it.
    const changingUpstream = () => {
      const upstream = { mode: "ok" as "ok" | "404" | "robots" };
      const engine = testEngine(async (request) => {
        if (request.url.endsWith("/robots.txt")) {
          const body = upstream.mode === "robots" ? "User-agent: *\nDisallow: /\n" : "User-agent: *\nAllow: /\n";
          return { status: 200, headers: {}, body: Buffer.from(body) };
        }
        if (upstream.mode === "404") return { status: 404, headers: {}, body: Buffer.from("gone") };
        return { status: 200, headers: {}, body: PDF };
      });
      return { upstream, engine };
    };

    for (const mode of ["404", "robots"] as const) {
      it(`keeps the stored record when the document now ${mode === "404" ? "answers 404" : "is robots-disallowed"}`, async () => {
        // It used to be re-extracted from nothing and written over the complete
        // one: 6 Q/A pairs became 0, reported as stored, with no error.
        const store = new MemoryStore();
        const { upstream, engine } = changingUpstream();
        const source = new StubSource();
        await sync({ source, store, engine, now: () => new Date("2026-01-02T03:04:05Z") });
        const before = store.getRecordBytes("berlin-19-10006");
        strictEqual(store.getRecord("berlin-19-10006")?.qa.length, 6);

        upstream.mode = mode;
        const report = await sync({ source, store, engine, now: () => new Date("2026-03-04T05:06:07Z") });
        strictEqual(report.stored, 0);
        strictEqual(report.unchanged, 1);
        deepStrictEqual(report.errors, []);
        ok(
          report.warnings.some((warning) => warning.includes(PDF_URL) && warning.includes("kept the archived copy retrieved 2026-01-02T03:04:05Z")),
          JSON.stringify(report.warnings),
        );
        deepStrictEqual(store.getRecordBytes("berlin-19-10006"), before);
      });
    }

    it("re-extracts from the archived copy when a re-extraction is forced", async () => {
      const store = new MemoryStore();
      const { upstream, engine } = changingUpstream();
      const source = new StubSource();
      await sync({ source, store, engine, now: () => new Date("2026-01-02T03:04:05Z") });
      upstream.mode = "404";
      const report = await sync({ source, store, engine, force: true, now: () => new Date("2026-03-04T05:06:07Z") });
      strictEqual(report.stored, 1);
      const record = store.getRecord("berlin-19-10006");
      strictEqual(record?.qa.length, 6);
      strictEqual(record?.source_documents[0]?.retrieved_at, "2026-01-02T03:04:05Z");
    });

    it("fails the ref and leaves the record alone when the archived copy is gone too", async () => {
      const first = new MemoryStore();
      const { upstream, engine } = changingUpstream();
      const source = new StubSource();
      await sync({ source, store: first, engine });
      // A corpus holding the record but not its bytes.
      const store = new MemoryStore();
      const record = first.getRecord("berlin-19-10006");
      ok(record !== undefined);
      store.putRecord(record);
      const before = store.getRecordBytes("berlin-19-10006");
      upstream.mode = "404";
      const report = await sync({ source, store, engine });
      strictEqual(report.stored, 0);
      strictEqual(report.failed, 1);
      match(report.errors[0] ?? "", /now answers 404, and the archived copy .* is missing; the stored record was left as it was/);
      deepStrictEqual(store.getRecordBytes("berlin-19-10006"), before);
    });

    it("names a 404 for a document it never had", async () => {
      const store = new MemoryStore();
      const { upstream, engine } = changingUpstream();
      upstream.mode = "404";
      const report = await sync({ source: new StubSource(), store, engine });
      strictEqual(report.stored, 1);
      ok(report.warnings.some((warning) => warning === `19/10006: ${PDF_URL} now answers 404`), JSON.stringify(report.warnings));
      ok(store.getRecord("berlin-19-10006")?.extraction.abstained_fields.includes("full_text"));
    });
  });

  it("refuses a reference whose record id collides with another's, or is empty", async () => {
    // "19/9.1" and "19/9-1" slug to the same id; the second replaced the first and
    // both counted as stored. "19/../.." slugged to nothing: id "berlin-19-".
    const ref = (reference: string, title: string) => ({
      key: reference,
      reference,
      legislative_period: 19,
      title,
      documentType: "schriftliche_anfrage" as const,
      askers: [],
      answered_by: {},
      dates: {},
      documents: [],
    });
    const source: Source = {
      key: "berlin",
      parliament: "berlin",
      tier: "structured",
      label: "stub",
      homepage: "https://example.invalid",
      notes: "test double",
      discover: async () => ({
        warnings: [],
        refs: [ref("19/9.1", "Kollision A"), ref("19/9-1", "Kollision B"), ref("19/../..", "Leer"), ref("19/10", "Normal")],
      }),
    };
    const store = new MemoryStore();
    const report = await sync({ source, store, engine: testEngine(async () => ({ status: 404, headers: {}, body: Buffer.alloc(0) })), metadataOnly: true });
    strictEqual(report.stored, 2);
    strictEqual(report.failed, 2);
    match(report.errors[0] ?? "", /19\/9-1: reference "19\/9-1" maps to record id berlin-19-9-1, which already holds "19\/9.1"/);
    match(report.errors[1] ?? "", /19\/\.\.\/\.\.: reference "19\/\.\.\/\.\." yields no record id/);
    strictEqual(store.getRecord("berlin-19-9-1")?.title, "Kollision A");
    strictEqual(store.getRecord("berlin-19-"), undefined);
  });

  it("treats a re-padded period as the same Drucksache, not a collision", async () => {
    const store = new MemoryStore();
    const engine = testEngine(async () => ({ status: 404, headers: {}, body: Buffer.alloc(0) }));
    const source = (reference: string): Source => ({
      key: "thueringen",
      parliament: "thueringen",
      tier: "structured",
      label: "stub",
      homepage: "https://example.invalid",
      notes: "test double",
      discover: async () => ({
        warnings: [],
        refs: [{ key: "k", reference, legislative_period: 8, title: "T", documentType: "kleine_anfrage", askers: [], answered_by: {}, dates: {}, documents: [] }],
      }),
    });
    await sync({ source: source("08/980"), store, engine, metadataOnly: true });
    const report = await sync({ source: source("8/980"), store, engine, metadataOnly: true });
    deepStrictEqual(report.errors, []);
    strictEqual(store.getRecord("thueringen-8-980")?.reference, "8/980");
  });

  it("fetches under --ignore-robots and records that it did", async () => {
    const store = new MemoryStore();
    const { transport, requests } = scriptedTransport([
      { match: "robots.txt", body: "User-agent: *\nDisallow: /\n" },
      { match: ".pdf", body: PDF },
    ]);
    const report = await sync({ source: new StubSource(), store, engine: testEngine(transport), ignoreRobots: true });
    strictEqual(report.stored, 1);
    ok(requests.some((request) => request.url.endsWith(".pdf")));
    ok(report.warnings.some((warning) => warning.includes("--ignore-robots was given")));
    strictEqual(store.getRecord("berlin-19-10006")?.qa.length, 6);
  });

  it("indexes a short run inside one catalog batch", async () => {
    const store = new MemoryStore();
    const { transport } = scriptedTransport([{ match: ".pdf", body: PDF }]);
    await sync({ source: new StubSource(), store, engine: testEngine(transport) });
    strictEqual(store.batches, 1);
  });

  it("saves the catalog every CATALOG_CHECKPOINT refs, so a killed run loses few rows", async () => {
    const store = new MemoryStore();
    const { transport } = scriptedTransport([{ match: ".pdf", body: PDF }]);
    const report = await sync({ source: new ManySource(CATALOG_CHECKPOINT + 2), store, engine: testEngine(transport) });
    strictEqual(report.stored, CATALOG_CHECKPOINT + 2);
    strictEqual(store.batches, 2);
  });

  // Findings 02#1 and 05#3 of the 2026-10-05 review: a run killed before its
  // catalog was saved left records on disk with no catalog row, and every later
  // run called them "unchanged" — invisible to search, stats and export for good.
  it("catalogues an unchanged record that an interrupted run left out of the catalog", async () => {
    const root = mkdtempSync(join(tmpdir(), "openka-interrupted-"));
    try {
      const store = new FileStore(root);
      const { transport } = scriptedTransport([{ match: ".pdf", body: PDF, headers: { etag: '"v1"' } }]);
      const options = { source: new StubSource(), store, engine: testEngine(transport), now: () => new Date("2026-01-02T03:04:05Z") };
      await sync(options);
      const shards = store.shardNames().map((shard) => JSON.stringify(store.loadShard(shard)));
      // What a kill before the flush left: the record and its postings, no catalog
      // row, no source state.
      rmSync(join(root, "index", "catalog.json"));
      rmSync(join(root, "state"), { recursive: true });
      const fresh = new FileStore(root);
      deepStrictEqual(catalogGaps(fresh), { uncatalogued: ["berlin-19-10006"], missingFiles: [] });

      const rerun = await sync({ ...options, store: fresh });
      strictEqual(rerun.unchanged, 1);
      strictEqual(rerun.recatalogued, 1);
      ok(fresh.catalogEntry("berlin-19-10006") !== undefined);
      deepStrictEqual(catalogGaps(fresh), { uncatalogued: [], missingFiles: [] });
      // Indexed again, not twice: every posting is where it was, once.
      deepStrictEqual(fresh.shardNames().map((shard) => JSON.stringify(fresh.loadShard(shard))), shards);

      const third = await sync({ ...options, store: new FileStore(root) });
      strictEqual(third.recatalogued, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Finding 02#4: a re-extraction read the new record back to decide which
  // postings to remove, so the words only the old document had stayed in the index.
  it("removes the old text's postings when a changed document is re-extracted", async () => {
    const store = new MemoryStore();
    const other = fixturesOf("@maschinenlesbar.org/openka-connector-berlin", import.meta.url).readFixture(
      "berlin",
      "berlin-19-10041",
      "1b11b97d7fbfc91f18ac5b101752d8dc25e39c5c64d76858f4b838c6bccc64c0.bin",
    );
    await sync({ source: new StubSource(), store, engine: testEngine(scriptedTransport([{ match: ".pdf", body: PDF }]).transport) });
    const replaced = await sync({ source: new StubSource(), store, engine: testEngine(scriptedTransport([{ match: ".pdf", body: other }]).transport) });
    strictEqual(replaced.stored, 1);
    const afterSync = store.shardNames().map((shard) => [shard, store.loadShard(shard)] as const);
    reindexAll(store);
    deepStrictEqual(afterSync, store.shardNames().map((shard) => [shard, store.loadShard(shard)] as const));
  });

  // Finding 02#5: `--force` over unchanged bytes dropped a person's mark.
  it("keeps a human_verified mark through --force when nothing changed, and says when it drops one", async () => {
    const store = new MemoryStore();
    const engine = (body: Buffer) => testEngine(scriptedTransport([{ match: ".pdf", body }]).transport);
    await sync({ source: new StubSource(), store, engine: engine(PDF), now: () => new Date("2026-01-02T03:04:05Z") });
    markHumanVerified(store, "berlin-19-10006");
    const forced = await sync({ source: new StubSource(), store, engine: engine(PDF), force: true, now: () => new Date("2026-02-03T04:05:06Z") });
    strictEqual(forced.stored, 1);
    strictEqual(store.getRecord("berlin-19-10006")?.extraction.review_status, "human_verified");
    strictEqual(store.catalogEntry("berlin-19-10006")?.review_status, "human_verified");
    deepStrictEqual(forced.warnings, []);

    const other = fixturesOf("@maschinenlesbar.org/openka-connector-berlin", import.meta.url).readFixture(
      "berlin",
      "berlin-19-10041",
      "1b11b97d7fbfc91f18ac5b101752d8dc25e39c5c64d76858f4b838c6bccc64c0.bin",
    );
    const changed = await sync({ source: new StubSource(), store, engine: engine(other) });
    strictEqual(changed.stored, 1);
    ok(store.getRecord("berlin-19-10006")?.extraction.review_status !== "human_verified");
    ok(changed.warnings.some((warning) => /19\/10006: was marked human_verified; .* the mark was dropped/.test(warning)), changed.warnings.join("\n"));
  });

  // Finding 01#1: Bayern's own feed claims no askers and no dates; the stored
  // records had neither, unflagged, and the CLI advised filtering them by date.
  it("reads a Bayern feed record's askers and dates from its paper, and does not churn", async () => {
    const bayernPdf = fixturesOf("@maschinenlesbar.org/openka-connector-bayern", import.meta.url).readFixture(
      "bayern",
      "bayern-19-12032",
      "cb339c218d1db37c21166aab6cc63b3604313ad4ba762ed5a87c5768743c88f1.bin",
    );
    const url = drucksacheUrl(19, "12032");
    const feed: Source = {
      key: "bayern",
      parliament: "bayern",
      tier: "text_layer",
      label: "stub",
      homepage: "https://example.invalid",
      notes: "test double",
      discover: async () => ({ warnings: [], refs: [toRef({ reference: "19/12032", period: 19, number: "12032", subject: "Hightech Agenda" }, url)] }),
    };
    const store = new MemoryStore();
    const engine = testEngine(scriptedTransport([{ match: ".pdf", body: bayernPdf }]).transport);
    const first = await sync({ source: feed, store, engine, now: () => new Date("2026-07-01T00:00:00Z") });
    strictEqual(first.stored, 1);
    const record = store.getRecord("bayern-19-12032");
    deepStrictEqual(record?.askers, [{ name: "Ulrich Singer", party: "AfD" }]);
    deepStrictEqual(record?.dates, { submitted: "2026-04-01", answered: "2026-06-23" });
    ok(!record?.extraction.abstained_fields.some((field) => field === "askers" || field.startsWith("dates.")));
    strictEqual(search(store, "", { year: [2026], party: ["AfD"] }).total, 1);
    // The feed still states nothing; what the paper said is not a change to re-extract for.
    strictEqual((await sync({ source: feed, store, engine, now: () => new Date("2026-07-02T00:00:00Z") })).unchanged, 1);
  });

  it("says when a window was applied to answer dates because the source gave no question date", async () => {
    const combinedOnly: Source = {
      ...new StubSource(),
      key: "berlin",
      discover: async (options) => {
        const refs = (await new StubSource().discover(options)).refs.map((ref) => ({ ...ref, dates: { answered: "2021-11-12" } }));
        return { warnings: [], refs };
      },
    };
    const report = await sync({
      source: combinedOnly,
      store: new MemoryStore(),
      engine: testEngine(scriptedTransport([{ match: ".pdf", body: PDF }]).transport),
      since: "2021-11-01",
    });
    ok(report.warnings.some((warning) => /1 of 1 Anfragen carry no question date .* applied to their answer date/.test(warning)), report.warnings.join("\n"));
  });

  it("refuses a second sync on a corpus another sync is writing", async () => {
    const root = mkdtempSync(join(tmpdir(), "openka-concurrent-"));
    try {
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => (release = resolve));
      const { transport } = scriptedTransport([{ match: ".pdf", body: PDF }]);
      // The first sync is held inside its run, past the lock, until the second has tried.
      const slow: Transport = async (request) => {
        await held;
        return transport(request);
      };
      const first = sync({ source: new StubSource(), store: new FileStore(root), engine: testEngine(slow) });
      await new Promise((resolve) => setImmediate(resolve));
      await rejects(
        sync({ source: new StubSource(), store: new FileStore(root), engine: testEngine(transport) }),
        (err: unknown) => err instanceof CorpusLockedError && /sync --source berlin/.test((err as Error).message),
      );
      release();
      strictEqual((await first).stored, 1);
      // Released: the next run gets in, and nothing was lost.
      strictEqual((await sync({ source: new StubSource(), store: new FileStore(root), engine: testEngine(transport) })).unchanged, 1);
      deepStrictEqual(catalogGaps(new FileStore(root)), { uncatalogued: [], missingFiles: [] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stops between refs when its signal is aborted, and keeps what it stored", async () => {
    const store = new MemoryStore();
    const { transport } = scriptedTransport([{ match: ".pdf", body: PDF }]);
    const controller = new AbortController();
    const report = await sync({
      source: new ManySource(3),
      store,
      engine: testEngine(transport),
      signal: controller.signal,
      onProgress: (event) => {
        if (event.index === 1) controller.abort();
      },
    });
    strictEqual(report.interrupted, true);
    strictEqual(report.stored, 1);
    strictEqual(store.catalog().length, 1);
    strictEqual(store.getSourceState("berlin").last_success, undefined);
    ok(store.getSourceState("berlin").last_sync !== undefined);
  });

  it("reports the discovered count before the first record, for a progress display", async () => {
    const { transport } = scriptedTransport([{ match: ".pdf", body: PDF }]);
    const seen: string[] = [];
    await sync({
      source: new ManySource(3),
      store: new MemoryStore(),
      engine: testEngine(transport),
      onDiscovered: (count) => seen.push(`discovered ${count}`),
      onProgress: (event) => seen.push(`${event.index}/${event.total}`),
    });
    deepStrictEqual(seen, ["discovered 3", "1/3", "2/3", "3/3"]);
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

  it("lets a usage error out instead of filing it as a degraded source", async () => {
    // Bayern refuses a date window it cannot apply. That must reach the operator
    // as a usage error (exit 2), not sit in `last_error` as if the Land were down.
    const store = new MemoryStore();
    const source: Source = {
      key: "bayern",
      parliament: "bayern",
      tier: "text_layer",
      label: "stub",
      homepage: "https://example.invalid",
      notes: "test double",
      discover: async () => {
        throw new UsageError("this source cannot apply --since");
      },
    };
    const { transport } = scriptedTransport([]);
    await rejects(() => sync({ source, store, engine: testEngine(transport) }), UsageError);
    strictEqual(store.getSourceState("bayern").last_error, undefined);
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
    // A corpus problem, as `ka open` calls it (finding 02#6): exit 3, not 1.
    strictEqual(result.unreadable, true);
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

  it("reproduces a record whose source tier was kept because nothing parsed", async () => {
    // verify used to re-request text_layer for every non-OCR record, which only
    // worked because an unparsed record was always labelled structured.
    for (const tier of ["structured", "text_layer"] as const) {
      const store = new MemoryStore();
      const source = Object.assign(new StubSource(), { tier });
      await sync({ source, store, engine: testEngine(async () => ({ status: 200, headers: {}, body: PDF.subarray(0, 200) })) });
      strictEqual(store.getRecord("berlin-19-10006")?.extraction.tier, tier);
      const result = await verifyRecord("berlin-19-10006", { store, env: {} });
      strictEqual(result.ok, true, `${tier}: ${result.reason} ${result.differences.join(", ")}`);
    }
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
    const report = await verifyGoldens({ workspace: PROJECT_ROOT });
    for (const result of report.results) {
      strictEqual(result.ok, true, `${result.id}: ${result.reason} ${result.differences.join(", ")}`);
    }
    assertGoldensPass(report);
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

describe("source status", () => {
  it("joins the registry with each source's record count and sync state", () => {
    const store = new MemoryStore();
    store.putSourceState({ source: "berlin", last_sync: "2026-01-01T00:00:00Z", last_error: "HTTP 503 from upstream", http_cache: {} });
    const registry = [
      { key: "berlin", parliament: "berlin" as const, label: "Berlin", status: "implemented" as const, note: "n" },
      { key: "parlamentsspiegel", label: "PS", status: "implemented" as const, note: "all" },
    ];
    const record = sampleRecord();
    store.putRecord(record);
    indexRecord(store, record);
    deepStrictEqual(sourceStatus(store, registry), [
      { key: "berlin", parliament: "berlin", label: "Berlin", status: "implemented", records: 1, last_sync: "2026-01-01T00:00:00Z", last_success: undefined, last_error: "HTTP 503 from upstream", note: "n" },
      // A source with no parliament of its own has no record count of its own.
      { key: "parlamentsspiegel", parliament: undefined, label: "PS", status: "implemented", records: undefined, last_sync: undefined, last_success: undefined, last_error: undefined, note: "all" },
    ]);
  });
});

describe("the sync window", () => {
  it("names the bounds and the reasons ka prints", () => {
    deepStrictEqual([SYNC_LIMIT_MIN, PERIOD_RANGE], [1, [1, 99]]);
    strictEqual(syncLimitProblem(1), undefined);
    strictEqual(syncLimitProblem(0), "Must be >= 1.");
    strictEqual(syncLimitProblem(2.5), "Expected an integer.");
    strictEqual(syncPeriodProblem(99), undefined);
    strictEqual(syncPeriodProblem(100), "Must be <= 99.");
    strictEqual(syncPeriodProblem(Number.NaN), "Expected an integer.");
  });

  it("trims the dates and keeps what is valid, idempotently", () => {
    const window = normalizeSyncWindow({ since: " 2024-01-01", until: "2024-12-31 ", period: 19, limit: 5 });
    deepStrictEqual(window, { since: "2024-01-01", until: "2024-12-31", period: 19, limit: 5 });
    deepStrictEqual(normalizeSyncWindow(window), window);
    deepStrictEqual(normalizeSyncWindow({}), {});
  });

  it("refuses a bad window before discovery, and records no source error", async () => {
    for (const [window, message] of [
      [{ since: "" }, "Invalid since: Expected a date as YYYY-MM-DD."],
      [{ until: "2024-02-30" }, "Invalid until: Not a calendar date."],
      [{ period: 0 }, "Invalid period: Must be >= 1."],
      [{ limit: -1 }, "Invalid limit: Must be >= 1."],
      [{ since: "2024-06-01", until: "2024-01-01" }, "Invalid until: Must be >= since (2024-06-01)."],
    ] as const) {
      const source = new StubSource();
      const store = new MemoryStore();
      await rejects(
        sync({ source, store, engine: testEngine(async () => ({ status: 200, headers: {}, body: PDF })), ...window }),
        (error: unknown) => error instanceof OpenKaValidationError && error.message === message,
      );
      strictEqual(source.discoveries, 0);
      strictEqual(store.getSourceState("berlin").last_error, undefined);
    }
  });

  it("hands discovery the trimmed window", async () => {
    let seen: DiscoverOptions | undefined;
    const source = Object.assign(new StubSource(), {
      async discover(options: DiscoverOptions): Promise<DiscoverResult> {
        seen = options;
        return { refs: [], warnings: [] };
      },
    });
    await sync({ source, store: new MemoryStore(), engine: testEngine(async () => ({ status: 200, headers: {}, body: PDF })), since: " 2024-01-01", until: "2024-12-31 " });
    deepStrictEqual([seen?.since, seen?.until], ["2024-01-01", "2024-12-31"]);
  });
});

describe("several sources in one run (issue #3)", () => {
  /** A source of another parliament (or of none, an aggregator), so it may run beside the Berlin stub. */
  class OtherSource implements Source {
    readonly tier = "structured" as const;
    readonly label = "stub";
    readonly homepage = "https://example.invalid";
    readonly notes = "test double";
    minHostIntervalMs?: number;
    readonly started: Promise<void>;
    private markStarted!: () => void;
    constructor(
      readonly key: string,
      readonly parliament: "saarland" | undefined,
      private readonly fail?: Error,
    ) {
      this.started = new Promise((resolve) => (this.markStarted = resolve));
    }
    async discover(options: DiscoverOptions): Promise<DiscoverResult> {
      this.markStarted();
      if (this.fail !== undefined) throw this.fail;
      const result = await new StubSource().discover(options);
      return {
        ...result,
        refs: result.refs.map((ref) => ({ ...ref, parliament: "saarland" as const, reference: "17/1", legislative_period: 17 })),
      };
    }
  }

  it("puts sources of one parliament in one lane, and an aggregator after all lanes", () => {
    const plan = planLanes([
      { key: "bund", parliament: "bund" },
      { key: "berlin", parliament: "berlin" },
      { key: "parlamentsspiegel", parliament: undefined },
      { key: "berlin-again", parliament: "berlin" },
    ] as const);
    deepStrictEqual(
      { concurrent: plan.concurrent.map((lane) => lane.map((source) => source.key)), after: plan.after.map((source) => source.key) },
      { concurrent: [["bund"], ["berlin", "berlin-again"]], after: ["parlamentsspiegel"] },
    );
  });

  it("runs sources of different parliaments side by side, under one lock", { timeout: 5000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "openka-many-"));
    try {
      const store = new FileStore(root);
      const { transport } = scriptedTransport([{ match: ".pdf", body: PDF }]);
      // Berlin's discovery waits for Saarland's to start: run one after the other,
      // this would never finish.
      const saarland = new OtherSource("saarland", "saarland");
      const berlin = new (class extends StubSource {
        override async discover(options: DiscoverOptions): Promise<DiscoverResult> {
          await saarland.started;
          return super.discover(options);
        }
      })();
      const started: string[] = [];
      const outcomes = await syncSources({
        sources: [berlin, saarland],
        store,
        engineFor: () => testEngine(transport),
        onStart: (source) => started.push(source),
      });
      deepStrictEqual(outcomes.map((outcome) => [outcome.source, outcome.status]), [["berlin", "done"], ["saarland", "done"]]);
      deepStrictEqual(store.catalog().map((row) => row.id), ["berlin-19-10006", "saarland-17-1"]);
      ok(!existsSync(join(root, "lock")), "the lock is released");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps going when one source fails, and runs an aggregator after the rest", async () => {
    const store = new MemoryStore();
    const { transport } = scriptedTransport([{ match: ".pdf", body: PDF }]);
    const started: string[] = [];
    const broken = new OtherSource("saarland", "saarland", new UsageError("no such period"));
    const aggregator = new OtherSource("aggregator", undefined);
    const outcomes = await syncSources({
      sources: [aggregator, broken, new StubSource()],
      store,
      engineFor: () => testEngine(transport),
      onStart: (source) => started.push(source),
    });
    strictEqual(started.at(-1), "aggregator");
    deepStrictEqual(outcomes.map((outcome) => [outcome.source, outcome.status]), [
      ["aggregator", "done"],
      ["saarland", "failed"],
      ["berlin", "done"],
    ]);
    const failed = outcomes[1];
    ok(failed?.status === "failed" && failed.error instanceof UsageError);
  });

  it("gives each source its own engine, so one source's politeness floor slows no other", async () => {
    const { transport } = scriptedTransport([{ match: ".pdf", body: PDF }]);
    const slow = new OtherSource("saarland", "saarland");
    slow.minHostIntervalMs = 4000;
    const engines = new Map<string, ReturnType<typeof testEngine>>();
    await syncSources({
      sources: [new StubSource(), slow],
      store: new MemoryStore(),
      engineFor: (source) => {
        const engine = testEngine(transport);
        engines.set(source.key, engine);
        return engine;
      },
    });
    strictEqual(engines.size, 2);
    ok(engines.get("berlin") !== engines.get("saarland"));
  });

  it("skips the sources whose turn had not come when the signal is aborted", async () => {
    const { transport } = scriptedTransport([{ match: ".pdf", body: PDF }]);
    const controller = new AbortController();
    const outcomes = await syncSources({
      sources: [new StubSource(), new OtherSource("aggregator", undefined)],
      store: new MemoryStore(),
      engineFor: () => testEngine(transport),
      signal: controller.signal,
      onDone: () => controller.abort(),
    });
    deepStrictEqual(outcomes.map((outcome) => outcome.status), ["done", "skipped"]);
  });
});

describe("a dry run (issue #6)", () => {
  /** `count` refs, each with its own document URL, so there is something to sample. */
  class SpreadSource extends StubSource {
    constructor(private readonly refCount: number) {
      super();
    }
    override async discover(options: DiscoverOptions): Promise<DiscoverResult> {
      const one = (await super.discover(options)).refs[0];
      ok(one !== undefined);
      const refs = Array.from({ length: this.refCount }, (_, i) => ({
        ...one,
        key: `V-${i + 1}`,
        reference: `19/${10006 + i}`,
        // Two roles, one URL: the document is fetched — and counted — once.
        documents: [
          { role: "question_pdf" as const, url: `https://pardok.example.invalid/S19-${10006 + i}.pdf`, urlStable: true },
          { role: "answer_pdf" as const, url: `https://pardok.example.invalid/S19-${10006 + i}.pdf`, urlStable: true },
        ],
      }));
      return { warnings: [], refs };
    }
  }

  it("counts, samples with HEAD and estimates, without fetching a document or writing anything", async () => {
    const store = new MemoryStore();
    const { transport, requests } = scriptedTransport([
      { match: "robots.txt", status: 404 },
      { match: ".pdf", headers: { "content-length": "110000" } },
    ]);
    const plan = await planSync({ source: new SpreadSource(50), store, engine: testEngine(transport), since: "2021-01-01" });
    deepStrictEqual(plan, {
      source: "berlin",
      window: { since: "2021-01-01" },
      discovered: 50,
      in_corpus: 0,
      documents_to_fetch: 50,
      estimate: { average_bytes: 110000, total_bytes: 5_500_000, basis: "head-sample", sampled: DRY_RUN_SAMPLE },
      warnings: [],
    });
    deepStrictEqual(new Set(requests.filter((request) => request.url.endsWith(".pdf")).map((request) => request.method)), new Set(["HEAD"]));
    strictEqual(store.catalog().length, 0);
    deepStrictEqual(store.getSourceState("berlin"), { source: "berlin", http_cache: {} });
  });

  it("leaves out what the corpus holds, and estimates from the corpus once it holds enough", async () => {
    const root = mkdtempSync(join(tmpdir(), "openka-plan-"));
    try {
      const store = new FileStore(root);
      const { transport, requests } = scriptedTransport([{ match: ".pdf", body: PDF, headers: { etag: '"v1"' } }]);
      await sync({ source: new StubSource(), store, engine: testEngine(transport) });
      // Archived documents of this source, 1000 bytes each, under its validators.
      const cache: Record<string, { sha256: string }> = { ...store.getSourceState("berlin").http_cache } as never;
      for (let i = 0; i < ESTIMATE_MIN_KNOWN; i++) cache[`https://old.example.invalid/${i}.pdf`] = { sha256: store.putBlob(Buffer.alloc(1000, i)) };
      store.putSourceState({ ...store.getSourceState("berlin"), http_cache: cache });
      requests.length = 0;

      const plan = await planSync({ source: new StubSource(), store, engine: testEngine(transport) });
      strictEqual(plan.in_corpus, 1);
      strictEqual(plan.documents_to_fetch, 0, "the stored record's document is held under a validator");
      strictEqual(plan.estimate, undefined);

      const more = await planSync({ source: new SpreadSource(3), store, engine: testEngine(transport) });
      strictEqual(more.in_corpus, 1);
      strictEqual(more.documents_to_fetch, 3);
      strictEqual(more.estimate?.basis, "corpus");
      ok((more.estimate?.sampled ?? 0) >= ESTIMATE_MIN_KNOWN);
      ok(!requests.some((request) => request.method === "HEAD"), "no HEAD when the corpus can answer");
      ok(!requests.some((request) => request.url.endsWith(".pdf")), "and no document");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a window sync() would refuse, before asking anything", async () => {
    const { transport, requests } = scriptedTransport([]);
    await rejects(planSync({ source: new StubSource(), store: new MemoryStore(), engine: testEngine(transport), since: "2024-06-01", until: "2024-01-01" }), OpenKaValidationError);
    deepStrictEqual(requests, []);
  });
});

describe("counting the upstream beside the corpus (issue #5)", () => {
  const counting = (key: string, parliament: "berlin" | "bund" | undefined, count: Source["count"]): Source => ({
    key,
    ...(parliament === undefined ? {} : { parliament }),
    tier: "structured",
    label: key,
    homepage: "https://example.invalid",
    notes: "",
    discover: async () => ({ refs: [], warnings: [] }),
    ...(count === undefined ? {} : { count }),
  });

  it("puts each upstream count beside the corpus's records, per period, and notes what it could not count", async () => {
    const store = new MemoryStore();
    for (const [id, parliament, period] of [["berlin-19-1", "berlin", 19], ["berlin-18-1", "berlin", 18], ["bund-21-1", "bund", 21]] as const) {
      store.putCatalogEntry(toCatalogEntryFor(id, parliament, period));
    }
    const asked: (number | undefined)[] = [];
    const rows = await countSources({
      sources: [
        counting("berlin", "berlin", async (options) => (asked.push(options.period), { total: 100, basis: "Parlamentsspiegel" })),
        counting("bund", "bund", async () => {
          throw new UsageError("needs a key");
        }),
        counting("discover-only", "berlin", undefined),
        counting("aggregator", undefined, async () => ({ total: 1, basis: "Parlamentsspiegel" })),
      ],
      store,
      engineFor: () => testEngine(scriptedTransport([]).transport),
      period: 19,
    });
    deepStrictEqual(asked, [19]);
    deepStrictEqual(
      rows.map(({ error: _error, ...row }) => row),
      [
        { source: "berlin", parliament: "berlin", in_corpus: 1, upstream: 100, basis: "Parlamentsspiegel", missing: 99 },
        { source: "bund", parliament: "bund", in_corpus: 0, note: "needs a key" },
        { source: "discover-only", parliament: "berlin", in_corpus: 1, note: "cannot count its upstream without discovering it; `ka sync --dry-run` does that" },
        // An aggregator counts the Länder: Berlin's record of period 19, not the Bundestag's.
        { source: "aggregator", parliament: undefined, in_corpus: 1, upstream: 1, basis: "Parlamentsspiegel", missing: 0 },
      ],
    );
    ok(rows[1]?.error instanceof UsageError, "the error is kept for a caller that rethrows it");
  });
});

function toCatalogEntryFor(id: string, parliament: string, period: number) {
  return { id, parliament, reference: `${period}/1`, legislative_period: period, title: "t", parties: [], review_status: "ok", tier: "structured", abstained: 0, terms: 1 };
}
