// The corpus: the file store, the inverted index, search and the semantic path.

import { deepStrictEqual, ok, rejects, strictEqual, throws } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, describe, it } from "node:test";
import { FileStore, archivedDocument, documentRoleProblem } from "@maschinenlesbar.org/openka-lib-store";
import { MissingCorpusError, StoreError } from "@maschinenlesbar.org/openka-lib-errors";
import type { CatalogStore, EmbeddingStore } from "@maschinenlesbar.org/openka-lib-store";
import { containsPhrase, normalizeTerm, normalizeWithOffsets, parseQuery, scoreTerm, shardOf, termFrequencies, tokenize } from "@maschinenlesbar.org/openka-lib-store";
import { corpusStats, indexableFields, indexRecord, markHumanVerified, reindexAll, toCatalogEntry, unindexRecord } from "@maschinenlesbar.org/openka-lib-store";
import { DEFAULT_REVIEW_LIMIT, makeSnippet, matchesFilters, reviewQueue, search, selectRecords } from "../src/search.js";
import {
  DEFAULT_SEARCH_LIMIT,
  LIMIT_MIN,
  OFFSET_MIN,
  PERIOD_RANGE,
  YEAR_RANGE,
  assertPaging,
  intRangeProblem,
  limitProblem,
  normalizeSearchFilters,
  offsetProblem,
  reviewStatusProblem,
  searchParliamentProblem,
  searchableQueryProblem,
} from "../src/filters.js";
import { OpenKaValidationError } from "@maschinenlesbar.org/openka-lib-errors";
import { cosine, searchLike } from "../src/semantic.js";
import { canonicalJsonLine } from "@maschinenlesbar.org/openka-lib-repro";
import { sha256 } from "@maschinenlesbar.org/openka-lib-repro";
import { MemoryStore, sampleRecord } from "@maschinenlesbar.org/openka-lib-testing";

describe("tokenizer", () => {
  it("folds German umlauts the way a searcher expects", () => {
    strictEqual(normalizeTerm("Brücken"), "bruecken");
    deepStrictEqual(tokenize("Brücken-Zustand 2024"), ["bruecken", "zustand", "2024"]);
  });

  it("maps a normalised offset back onto the original text", () => {
    const { normalized, offsets } = normalizeWithOffsets("Brücken");
    strictEqual(normalized, "bruecken");
    // "ue" both come from the single source character at index 2.
    strictEqual(offsets[2], 2);
    strictEqual(offsets[3], 2);
    strictEqual(offsets[4], 3);
  });

  it("drops single characters, which carry no selectivity", () => {
    deepStrictEqual(tokenize("a bb ccc"), ["bb", "ccc"]);
  });

  it("weights title terms above body terms", () => {
    const counts = termFrequencies({ title: "Brücke", body: "Brücke" });
    strictEqual(counts.get("bruecke"), 4); // 3 for the title plus 1 for the body
  });

  it("shards a token deterministically", () => {
    strictEqual(shardOf("bruecke"), shardOf("bruecke"));
    ok(/^[0-9a-f]{2}$/.test(shardOf("bruecke")));
  });

  it("scores a rarer term higher", () => {
    ok(scoreTerm(1, 1, 100) > scoreTerm(1, 50, 100));
  });
});

describe("query syntax", () => {
  it("treats every bare term as required", () => {
    deepStrictEqual(parseQuery("brücken zustand").required, ["bruecken", "zustand"]);
  });

  it("collects a quoted phrase and requires its words", () => {
    const parsed = parseQuery('"marode brücke" sanierung');
    deepStrictEqual(parsed.phrases, [["marode", "bruecke"]]);
    deepStrictEqual(parsed.required, ["marode", "bruecke", "sanierung"]);
  });

  it("collects excluded terms", () => {
    deepStrictEqual(parseQuery("brücke -sanierung").excluded, ["sanierung"]);
  });

  it("confirms a phrase only when the words are adjacent", () => {
    ok(containsPhrase("eine marode Brücke", ["marode", "bruecke"]));
    strictEqual(containsPhrase("eine Brücke, marode", ["marode", "bruecke"]), false);
  });
});

describe("two runs over one corpus", () => {
  it("does not drop the other run's catalog rows", () => {
    // A corpus is a directory and nothing locks it. Both runs cached the catalog
    // at startup and then wrote it whole, so the second dropped the first's rows:
    // the record stayed on disk and vanished from search, stats, export and
    // health, with only `ka reindex` to recover it.
    const root = mkdtempSync(join(tmpdir(), "openka-conc-"));
    try {
      const first = new FileStore(root);
      const second = new FileStore(root);
      first.catalog();
      second.catalog();
      const a = sampleRecord({ id: "berlin-19-11111", reference: "19/11111" });
      const b = sampleRecord({ id: "berlin-19-22222", reference: "19/22222" });
      first.putRecord(a);
      indexRecord(first, a);
      second.putRecord(b);
      indexRecord(second, b);

      const fresh = new FileStore(root);
      deepStrictEqual(
        fresh.catalog().map((row) => row.id).sort(),
        ["berlin-19-11111", "berlin-19-22222"],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes the catalog once for a batch, not once per row", async () => {
    // `indexRecord` used to persist the catalog twice per record (a removal, then
    // an insert), each a full re-read and rewrite of the file — quadratic in the
    // corpus. Inside a batch nothing is written until the batch ends.
    const root = mkdtempSync(join(tmpdir(), "openka-batch-"));
    try {
      const store = new FileStore(root);
      let flushes = 0;
      const realFlush = store.flushCatalog.bind(store);
      store.flushCatalog = () => {
        flushes++;
        realFlush();
      };
      const records = Array.from({ length: 4 }, (_, i) =>
        sampleRecord({ id: `berlin-19-2000${i}`, reference: `19/2000${i}` }),
      );
      await store.batchCatalog(async () => {
        for (const record of records) {
          store.putRecord(record);
          indexRecord(store, record);
        }
        // Reads inside the batch see the rows already.
        strictEqual(store.catalog().length, 4);
        strictEqual(flushes, 0);
      });
      strictEqual(flushes, 1);
      strictEqual(new FileStore(root).catalog().length, 4);

      // A batch that throws still persists what it indexed.
      await rejects(
        store.batchCatalog(async () => {
          indexRecord(store, sampleRecord({ id: "berlin-19-30000", reference: "19/30000" }));
          throw new Error("interrupted");
        }),
        /interrupted/,
      );
      strictEqual(flushes, 2);
      ok(new FileStore(root).catalogEntry("berlin-19-30000") !== undefined);

      // Outside a batch every write persists, as before.
      indexRecord(store, sampleRecord({ id: "berlin-19-40000", reference: "19/40000" }));
      ok(flushes > 2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("still honours a removal against a concurrent writer", () => {
    const root = mkdtempSync(join(tmpdir(), "openka-conc-"));
    try {
      const seed = new FileStore(root);
      const record = sampleRecord({ id: "berlin-19-33333", reference: "19/33333" });
      seed.putRecord(record);
      indexRecord(seed, record);

      const remover = new FileStore(root);
      unindexRecord(remover, "berlin-19-33333");
      deepStrictEqual(new FileStore(root).catalog(), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("rebuilding the index", () => {
  it("writes each shard once for the whole corpus, not once per record", () => {
    // Indexing a record at a time read-modify-writes one file per shard its
    // tokens touch, and a real record touches 130–182 of the 256. Batching took
    // 200 records from ~10 s to ~0.2 s; this pins the shape rather than the time.
    const store = new MemoryStore();
    const records = Array.from({ length: 5 }, (_, i) =>
      sampleRecord({ id: `berlin-19-1000${i}`, reference: `19/1000${i}` }),
    );
    for (const record of records) store.putRecord(record);

    let shardWrites = 0;
    const realSave = store.saveShard.bind(store);
    store.saveShard = (shard, data) => {
      shardWrites++;
      realSave(shard, data);
    };
    const count = reindexAll(store);

    strictEqual(count, 5);
    // One clearing pass plus one write per distinct shard — never 5 × the shards.
    const distinctShards = new Set(
      records.flatMap((record) => [...termFrequencies(indexableFields(record)).keys()]).map(shardOf),
    );
    ok(shardWrites <= distinctShards.size * 2, `${shardWrites} writes for ${distinctShards.size} shards`);
    // And the index still answers.
    strictEqual(search(store, "brücken").total, 5);
  });
});

describe("the store's roles", () => {
  it("lets a consumer depend on the part it uses", () => {
    // The point of the split: a catalog-and-embeddings consumer compiles against
    // a double that implements neither blobs nor shards nor artifacts.
    const vectors = { a: [1, 0], b: [0.9, 0.1] };
    const tiny: EmbeddingStore & CatalogStore = {
      loadEmbeddings: () => ({ model: "test", dimensions: 2, vectors }),
      saveEmbeddings: () => undefined,
      catalog: () => [],
      catalogEntry: (id) => toCatalogEntry(sampleRecord({ id: "berlin-19-12345" }), 1) && id === "b"
        ? toCatalogEntry(sampleRecord(), 1)
        : undefined,
      putCatalogEntry: () => undefined,
      putCatalogEntries: () => undefined,
      removeCatalogEntry: () => undefined,
      replaceCatalog: () => undefined,
      batchCatalog: (work) => work(),
    };
    const { total, hits } = searchLike(tiny, "a");
    deepStrictEqual([total, hits.length], [1, 1]);
    strictEqual(hits[0]?.entry.id, "berlin-19-12345");
  });
});

describe("file store", () => {
  const root = mkdtempSync(join(tmpdir(), "openka-store-"));
  after(() => rmSync(root, { recursive: true, force: true }));
  const store = new FileStore(root);

  it("stores blobs under their own digest and is idempotent", () => {
    const digest = store.putBlob(Buffer.from("hello"));
    strictEqual(digest, sha256("hello"));
    strictEqual(store.putBlob(Buffer.from("hello")), digest);
    ok(store.hasBlob(digest));
    strictEqual(store.getBlob(digest).toString(), "hello");
  });

  it("writes records in canonical form, byte for byte", () => {
    const record = sampleRecord();
    store.putRecord(record);
    const onDisk = readFileSync(join(root, "records", "berlin-19-12345.json"), "utf8");
    strictEqual(onDisk, canonicalJsonLine(record));
    strictEqual(store.getRecordBytes(record.id)?.toString("utf8"), canonicalJsonLine(record));
  });

  it("refuses to store an invalid record", () => {
    throws(() => store.putRecord(sampleRecord({ id: "wrong-id" })), /Invalid record/);
  });

  it("refuses a record id that would escape the records directory", () => {
    throws(() => store.getRecord("../../etc/passwd"), /Unsafe record id/);
  });

  it("refuses a blob name that is not a digest", () => {
    throws(() => store.blobPath("not-a-digest"), /Not a sha256/);
  });

  it("calls a catalog of the wrong shape corrupt, instead of crashing a reader", () => {
    // `{"a":1}` gave "rows.map is not a function" and a row with no title a
    // TypeError in search — each an "Unexpected error", not a corpus problem.
    const dir = mkdtempSync(join(tmpdir(), "openka-catalog-"));
    try {
      mkdirSync(join(dir, "index"), { recursive: true });
      for (const [content, reason] of [
        ['{"a":1}', /not a list of rows/],
        ['[{"id":"../../evil","parliament":"berlin"}]', /row 0 has no safe record id/],
        ['[{"id":"berlin-19-1","parliament":"berlin"}]', /row 0 \(berlin-19-1\) has no reference/],
      ] as const) {
        writeFileSync(join(dir, "index", "catalog.json"), content);
        throws(() => new FileStore(dir).catalog(), (err: unknown) => err instanceof StoreError && reason.test(err.message));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rebuilds a corrupt catalog without reading it, and names an unreadable record", () => {
    // `ka reindex` read the old catalog in order to clear it, so a catalog that
    // would not parse was the one thing it could not repair.
    const dir = mkdtempSync(join(tmpdir(), "openka-reindex-"));
    try {
      const fresh = new FileStore(dir);
      fresh.putRecord(sampleRecord());
      fresh.putRecord(sampleRecord({ id: "berlin-19-2", reference: "19/2" }));
      mkdirSync(join(dir, "index"), { recursive: true });
      writeFileSync(join(dir, "index", "catalog.json"), "[1,2");
      writeFileSync(join(dir, "records", "berlin-19-2.json"), '{"broken');
      const store = new FileStore(dir);
      throws(() => store.catalog(), StoreError);
      // Without a handler an unreadable record still aborts, as it always did.
      throws(() => reindexAll(new FileStore(dir)), /Corrupt record berlin-19-2/);
      const skipped: string[] = [];
      strictEqual(reindexAll(store, { onUnreadable: (id) => skipped.push(id) }), 1);
      deepStrictEqual(skipped, ["berlin-19-2"]);
      deepStrictEqual(new FileStore(dir).catalog().map((entry) => entry.id), ["berlin-19-12345"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps per-source state", () => {
    store.putSourceState({ source: "berlin", http_cache: { "https://x": { etag: '"1"' } }, last_sync: "2026-01-01T00:00:00Z" });
    strictEqual(store.getSourceState("berlin").http_cache["https://x"]?.etag, '"1"');
    deepStrictEqual(store.getSourceState("unknown"), { source: "unknown", http_cache: {} });
  });
});

describe("indexing and search", () => {
  function corpus(): MemoryStore {
    const store = new MemoryStore();
    const records = [
      sampleRecord(),
      sampleRecord({
        id: "berlin-19-22222",
        reference: "19/22222",
        title: "Sanierung der Radwege",
        askers: [{ name: "Max Beispiel", party: "GRÜNE" }],
        dates: { submitted: "2023-01-10", answered: "2023-02-01" },
        qa: [{ number: "1", question: "Wie viele Radwege?", answer: "Sehr viele Radwege." }],
        full_text: "Radwege überall",
      }),
      sampleRecord({
        id: "bund-21-7563",
        parliament: "bund",
        document_type: "kleine_anfrage",
        reference: "21/7563",
        legislative_period: 21,
        title: "Brücken im Bund",
        askers: [{ name: "Alex Bund", party: "SPD" }],
        dates: { submitted: "2026-08-13", answered: "2026-09-10" },
        qa: [{ number: "1", answer: "Eine Antwort." }],
      }),
    ];
    for (const record of records) {
      store.putRecord(record);
      indexRecord(store, record);
    }
    return store;
  }

  it("projects a record into a catalog row", () => {
    const entry = toCatalogEntry(sampleRecord(), 12);
    strictEqual(entry.year, 2024);
    deepStrictEqual(entry.parties, ["spd"]);
    strictEqual(entry.terms, 12);
  });

  it("finds every record containing a term, title matches first", () => {
    const result = search(corpus(), "brücken");
    // "Brücken im Bund" has the term in its title, which outweighs the Berlin
    // record's single occurrence in a question.
    deepStrictEqual(result.hits.map((hit) => hit.entry.id), ["bund-21-7563", "berlin-19-12345"]);
  });

  it("requires every term (AND semantics)", () => {
    strictEqual(search(corpus(), "brücken radwege").total, 0);
  });

  it("honours an excluded term", () => {
    const result = search(corpus(), "brücken -bund");
    deepStrictEqual(result.hits.map((hit) => hit.entry.id), ["berlin-19-12345"]);
  });

  it("centres a snippet on a term whose umlaut was expanded", () => {
    // The term reaches `makeSnippet` as "bruecken"; the text says "Brücken".
    // Before the offsets were tracked this fell back to the first 240 characters.
    const snippet = makeSnippet(corpus(), "berlin-19-12345", ["bruecken"]);
    ok(snippet !== undefined);
    ok(/[Bb]rücken/.test(snippet));
  });

  it("answers a query that is only exclusions with everything else", () => {
    // `-bund` is a real constraint, not an empty query: it means "everything that
    // does not mention it", never "nothing".
    const result = search(corpus(), "-bund");
    strictEqual(result.total, 2);
    ok(!result.hits.some((hit) => hit.entry.id === "bund-21-7563"));
  });

  it("filters by parliament, party and year", () => {
    const store = corpus();
    strictEqual(search(store, "", { parliament: ["bund"] }).total, 1);
    strictEqual(search(store, "", { party: ["grüne"] }).total, 1);
    strictEqual(search(store, "", { year: [2023] }).total, 1);
    strictEqual(search(store, "", { from: "2026-01-01" }).total, 1);
  });

  it("lists everything that passes the filters when the query is empty", () => {
    strictEqual(search(corpus(), "").total, 3);
  });

  it("orders ties by id so two runs agree", () => {
    const first = search(corpus(), "brücken").hits.map((hit) => hit.entry.id);
    const second = search(corpus(), "brücken").hits.map((hit) => hit.entry.id);
    deepStrictEqual(first, second);
  });

  it("returns a snippet around the match when asked", () => {
    const result = search(corpus(), "radwege", { snippet: true });
    ok(result.hits[0]?.snippet?.includes("Radwege"));
  });

  it("removes a record's postings when it is unindexed", () => {
    const store = corpus();
    unindexRecord(store, "berlin-19-22222");
    strictEqual(search(store, "radwege").total, 0);
    strictEqual(store.catalogEntry("berlin-19-22222"), undefined);
  });

  it("rebuilds the whole index from the records", () => {
    const store = corpus();
    for (const shard of store.shardNames()) store.saveShard(shard, {});
    for (const entry of store.catalog()) store.removeCatalogEntry(entry.id);
    strictEqual(search(store, "brücken").total, 0);
    strictEqual(reindexAll(store), 3);
    strictEqual(search(store, "brücken").total, 2);
  });

  it("matches filters on a catalog row directly", () => {
    const entry = toCatalogEntry(sampleRecord(), 1);
    ok(matchesFilters(entry, { parliament: ["berlin"] }));
    strictEqual(matchesFilters(entry, { parliament: ["bund"] }), false);
    strictEqual(matchesFilters(entry, { onlyAbstained: true }), false);
  });
});

describe("semantic search", () => {
  it("computes cosine similarity", () => {
    strictEqual(cosine([1, 0], [1, 0]), 1);
    strictEqual(cosine([1, 0], [0, 1]), 0);
    strictEqual(cosine([0, 0], [1, 1]), 0);
  });

  it("refuses to fall back to keyword search when no vectors were shipped", () => {
    const store = new MemoryStore();
    throws(() => searchLike(store, "berlin-19-12345"), /no frozen embeddings/);
  });

  it("ranks by similarity when vectors are present", () => {
    const store = new MemoryStore();
    for (const record of [sampleRecord(), sampleRecord({ id: "berlin-19-22222", reference: "19/22222" })]) {
      store.putRecord(record);
      indexRecord(store, record);
    }
    store.saveEmbeddings({
      model: "test",
      dimensions: 2,
      vectors: { "berlin-19-12345": [1, 0], "berlin-19-22222": [0.9, 0.1] },
    });
    const { total, hits } = searchLike(store, "berlin-19-12345");
    deepStrictEqual([total, hits.length], [1, 1]);
    strictEqual(hits[0]?.entry.id, "berlin-19-22222");
    // The total counts every similar record, not the page.
    strictEqual(searchLike(store, "berlin-19-12345", { limit: 1 }).total, 1);
  });
});

describe("selectRecords", () => {
  function corpus(count: number): MemoryStore {
    const store = new MemoryStore();
    for (let n = 1; n <= count; n++) {
      const record = sampleRecord({ id: `berlin-19-${String(n).padStart(5, "0")}`, reference: `19/${String(n).padStart(5, "0")}` });
      store.putRecord(record);
      indexRecord(store, record);
    }
    return store;
  }

  it("selects every match by default, not search()'s first page of 20", () => {
    const { records, missing } = selectRecords(corpus(25), "");
    strictEqual(records.length, 25);
    deepStrictEqual(missing, []);
  });

  it("applies the filters and a limit, in search order", () => {
    const store = corpus(25);
    deepStrictEqual(
      selectRecords(store, "", { limit: 3 }).records.map((record) => record.id),
      ["berlin-19-00001", "berlin-19-00002", "berlin-19-00003"],
    );
    strictEqual(selectRecords(store, "", { parliament: ["bayern"] }).records.length, 0);
  });

  it("names a catalog row whose record file is gone instead of dropping it silently", () => {
    const store = corpus(3);
    store.deleteRecord("berlin-19-00002");
    const { records, missing } = selectRecords(store, "");
    deepStrictEqual(records.map((record) => record.id), ["berlin-19-00001", "berlin-19-00003"]);
    deepStrictEqual(missing, ["berlin-19-00002"]);
  });
});

describe("the review queue", () => {
  function abstaining(id: string, reference: string, period: number, fields: string[]) {
    const parliament = id.split("-")[0] as ReturnType<typeof sampleRecord>["parliament"];
    return sampleRecord({
      id,
      parliament,
      reference,
      legislative_period: period,
      qa: [],
      ...(fields.includes("answered_by.ministry") ? { answered_by: {} } : {}),
      extraction: { ...sampleRecord().extraction, parse_complete: false, abstained_fields: fields, review_status: "needs_review" },
    });
  }
  function corpus(): MemoryStore {
    const store = new MemoryStore();
    for (const record of [
      sampleRecord(),
      abstaining("berlin-19-12346", "19/12346", 19, ["qa"]),
      abstaining("berlin-19-12347", "19/12347", 19, ["answered_by.ministry", "markers", "qa"]),
      abstaining("bayern-18-00001", "18/00001", 18, ["markers", "qa"]),
    ]) {
      store.putRecord(record);
      indexRecord(store, record);
    }
    return store;
  }
  const ids = (queue: { entries: { id: string }[] }): string[] => queue.entries.map((entry) => entry.id);

  it("lists records with holes, most abstentions first, ties on the id", () => {
    const queue = reviewQueue(corpus());
    strictEqual(queue.total, 3);
    deepStrictEqual(ids(queue), ["berlin-19-12347", "bayern-18-00001", "berlin-19-12346"]);
  });

  it("filters by parliament before it cuts at the limit", () => {
    const queue = reviewQueue(corpus(), { parliament: "berlin", limit: 1 });
    strictEqual(queue.total, 2);
    deepStrictEqual(ids(queue), ["berlin-19-12347"]);
    strictEqual(DEFAULT_REVIEW_LIMIT, 20);
  });

  it("leaves out a record a human verified, which the mark records in record and catalog alike", () => {
    const store = corpus();
    const marked = markHumanVerified(store, "berlin-19-12346");
    strictEqual(marked?.extraction.review_status, "human_verified");
    strictEqual(store.getRecord("berlin-19-12346")?.extraction.review_status, "human_verified");
    strictEqual(store.catalogEntry("berlin-19-12346")?.review_status, "human_verified");
    deepStrictEqual(ids(reviewQueue(store)), ["berlin-19-12347", "bayern-18-00001"]);
    strictEqual(search(store, "", { reviewStatus: ["human_verified"] }).total, 1);
    strictEqual(markHumanVerified(store, "berlin-19-99999"), undefined);
  });
});

describe("corpus statistics", () => {
  it("counts records, completeness, parliaments and tiers from the catalog", () => {
    const store = new MemoryStore();
    const incomplete = sampleRecord({
      id: "berlin-19-22222",
      reference: "19/22222",
      qa: [],
      extraction: { ...sampleRecord().extraction, parse_complete: false, abstained_fields: ["qa"], review_status: "needs_review" },
    });
    const bayern = sampleRecord({ id: "bayern-18-00001", parliament: "bayern", reference: "18/00001", legislative_period: 18 });
    for (const record of [sampleRecord(), incomplete, bayern]) {
      store.putRecord(record);
      indexRecord(store, record);
    }
    deepStrictEqual(corpusStats(store), {
      records: 3,
      parse_complete: 2,
      needs_review: 1,
      by_parliament: { bayern: { records: 1, abstained: 0 }, berlin: { records: 2, abstained: 1 } },
      by_tier: { text_layer: 3 },
    });
    deepStrictEqual(corpusStats(new MemoryStore()), { records: 0, parse_complete: 0, needs_review: 0, by_parliament: {}, by_tier: {} });
  });
});

describe("search filter rules", () => {
  it("normalises what has one canonical form and keeps the rest", () => {
    deepStrictEqual(
      normalizeSearchFilters({ parliament: ["Berlin", " BUND "], party: [" CDU "], from: " 2024-03-01", to: "2024-06-30 ", year: [2024], period: [19], reviewStatus: ["ok"], onlyAbstained: true }),
      { parliament: ["berlin", "bund"], party: ["cdu"], from: "2024-03-01", to: "2024-06-30", year: [2024], period: [19], reviewStatus: ["ok"], onlyAbstained: true },
    );
    deepStrictEqual(normalizeSearchFilters({}), {});
  });

  it("refuses a filter that cannot match, naming it", () => {
    const cases: [object, string][] = [
      [{ parliament: ["narnia"] }, `Invalid parliament: Unknown parliament "narnia". Known: `],
      [{ parliament: [""] }, "Invalid parliament: Expected a non-empty value."],
      [{ party: ["  "] }, "Invalid party: Expected a non-empty value."],
      [{ reviewStatus: ["verified"] }, "Invalid reviewStatus: Allowed choices are ok, needs_review, human_verified."],
      [{ year: [24] }, "Invalid year: Must be >= 1949."],
      [{ year: [2024.5] }, "Invalid year: Expected an integer."],
      [{ period: [0] }, "Invalid period: Must be >= 1."],
      [{ period: [100] }, "Invalid period: Must be <= 99."],
      [{ from: "2024-02-30" }, "Invalid from: Not a calendar date."],
      [{ to: "2024-1-5" }, "Invalid to: Expected a date as YYYY-MM-DD."],
    ];
    for (const [filters, message] of cases) {
      throws(
        () => normalizeSearchFilters(filters),
        (error: unknown) => error instanceof OpenKaValidationError && error.message.startsWith(message),
        JSON.stringify(filters),
      );
    }
  });

  it("exposes its rules and bounds for the CLI's parsers", () => {
    deepStrictEqual([YEAR_RANGE, PERIOD_RANGE], [[1949, 2999], [1, 99]]);
    strictEqual(intRangeProblem(1, 99)(50), undefined);
    strictEqual(searchParliamentProblem("Bund"), undefined);
    strictEqual(reviewStatusProblem("human_verified"), undefined);
  });

  it("is enforced by search() before it reads anything", () => {
    throws(() => search(new MemoryStore(), "", { parliament: ["narnia"] }), OpenKaValidationError);
  });
});

describe("search paging", () => {
  it("names a limit or offset that cannot page", () => {
    deepStrictEqual([DEFAULT_SEARCH_LIMIT, LIMIT_MIN, OFFSET_MIN], [20, 1, 0]);
    for (const [value, reason] of [[0, "Must be >= 1."], [-1, "Must be >= 1."], [1.5, "Expected an integer."], [Number.NaN, "Expected an integer."], [Infinity, "Expected an integer."]] as const) {
      strictEqual(limitProblem(value), reason);
    }
    strictEqual(limitProblem(1), undefined);
    strictEqual(limitProblem(Number.MAX_SAFE_INTEGER), undefined);
    strictEqual(offsetProblem(-1), "Must be >= 0.");
    strictEqual(offsetProblem(0.5), "Expected an integer.");
    strictEqual(offsetProblem(0), undefined);
  });

  it("refuses them in search(), searchLike(), selectRecords() and reviewQueue() before reading anything", () => {
    const store = new MemoryStore();
    const refused = (name: string, reason: string) => (error: unknown) =>
      error instanceof OpenKaValidationError && error.message === `Invalid ${name}: ${reason}`;
    throws(() => assertPaging({ limit: 0 }), refused("limit", "Must be >= 1."));
    throws(() => search(store, "", { limit: -1 }), refused("limit", "Must be >= 1."));
    throws(() => search(store, "", { offset: -2, limit: 1 }), refused("offset", "Must be >= 0."));
    throws(() => search(store, "", { limit: 1.5 }), refused("limit", "Expected an integer."));
    // Before the embeddings are read: this store has none, which would be a different error.
    throws(() => searchLike(store, "berlin-19-12345", { limit: -1 }), refused("limit", "Must be >= 1."));
    throws(() => selectRecords(store, "", { limit: 0 }), refused("limit", "Must be >= 1."));
    throws(() => reviewQueue(store, { limit: 0 }), refused("limit", "Must be >= 1."));
  });
});

describe("a searchable query", () => {
  it("names a non-blank query with no terms, and lets the rest through", () => {
    strictEqual(
      searchableQueryProblem("???"),
      'Nothing searchable in "???" — terms are runs of letters and digits of at least two characters, so this would have matched every record.',
    );
    for (const query of ["a", "-", "?x", "\"\""]) ok(searchableQueryProblem(query) !== undefined, query);
    for (const query of ["", "   ", "-radwege", "Brücken", '"Sanierung der Radwege"']) strictEqual(searchableQueryProblem(query), undefined, query);
  });

  it("is enforced by search() and selectRecords() before they read anything", () => {
    throws(() => search(new MemoryStore(), "???"), (error: unknown) => error instanceof OpenKaValidationError && error.message.startsWith("Invalid query: Nothing searchable"));
    throws(() => selectRecords(new MemoryStore(), "-"), OpenKaValidationError);
  });
});

describe("opening an existing corpus", () => {
  it("opens a directory, and refuses a missing path or a file without creating anything", () => {
    const root = mkdtempSync(join(tmpdir(), "openka-open-"));
    try {
      strictEqual(FileStore.open(root).root, root);
      const missing = join(root, "typo");
      throws(
        () => FileStore.open(missing),
        (error: unknown) =>
          error instanceof MissingCorpusError &&
          error instanceof StoreError &&
          error.root === missing &&
          error.message === `No corpus at ${missing}: nothing has been synced there.`,
      );
      ok(!existsSync(missing));
      writeFileSync(join(root, "afile"), "x");
      throws(() => FileStore.open(join(root, "afile")), (error: unknown) => error instanceof StoreError && /is not a directory/.test(error.message));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("a record's archived document", () => {
  it("names the roles a record can hold", () => {
    strictEqual(documentRoleProblem("combined_pdf"), undefined);
    for (const role of ["bogus", " combined_pdf", "COMBINED_PDF", ""]) {
      strictEqual(documentRoleProblem(role), "Allowed choices are question_pdf, answer_pdf, combined_pdf, metadata.");
    }
  });

  it("hands out a checked path, picked by role", () => {
    const store = new MemoryStore();
    const question = store.putBlob(Buffer.from("question"));
    const answer = store.putBlob(Buffer.from("answer"));
    store.putRecord(
      sampleRecord({
        source_documents: [
          { role: "metadata", url: "https://example.invalid/meta.xml", url_stable: true },
          { role: "question_pdf", url: "https://example.invalid/q.pdf", sha256: question, url_stable: true },
          { role: "answer_pdf", url: "https://example.invalid/a.pdf", sha256: answer, url_stable: true },
        ],
      }),
    );
    strictEqual(archivedDocument(store, "berlin-19-12345").document.role, "question_pdf");
    const picked = archivedDocument(store, "berlin-19-12345", { role: "answer_pdf" });
    deepStrictEqual([picked.document.sha256, picked.path], [answer, store.blobPath(answer)]);
    throws(() => archivedDocument(store, "berlin-19-12345", { role: "combined_pdf" }), /has no archived document with role combined_pdf/);
    throws(() => archivedDocument(store, "berlin-19-99999"), /^OpenKaError: No record berlin-19-99999 in \/memory$/);
    throws(() => archivedDocument(store, "berlin-19-12345", { role: "pdf" }), OpenKaValidationError);
  });
});
