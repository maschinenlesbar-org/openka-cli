// The corpus: the file store, the inverted index, search and the semantic path.

import { deepStrictEqual, ok, rejects, strictEqual, throws } from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, describe, it } from "node:test";
import { FileStore } from "@maschinenlesbar.org/openka-lib-store";
import type { CatalogStore, EmbeddingStore } from "@maschinenlesbar.org/openka-lib-store";
import { containsPhrase, normalizeTerm, normalizeWithOffsets, parseQuery, scoreTerm, shardOf, termFrequencies, tokenize } from "@maschinenlesbar.org/openka-lib-store";
import { indexableFields, indexRecord, reindexAll, toCatalogEntry, unindexRecord } from "@maschinenlesbar.org/openka-lib-store";
import { makeSnippet, matchesFilters, search } from "../src/search.js";
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
      batchCatalog: (work) => work(),
    };
    const hits = searchLike(tiny, "a");
    strictEqual(hits.length, 1);
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
    const hits = searchLike(store, "berlin-19-12345");
    strictEqual(hits.length, 1);
    strictEqual(hits[0]?.entry.id, "berlin-19-22222");
  });
});
