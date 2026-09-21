// The corpus: the file store, the inverted index, search and the semantic path.

import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, describe, it } from "node:test";
import { FileStore } from "../src/core/store/file-store.js";
import { containsPhrase, normalizeTerm, parseQuery, scoreTerm, shardOf, termFrequencies, tokenize } from "../src/core/store/fts.js";
import { indexRecord, reindexAll, toCatalogEntry, unindexRecord } from "../src/core/store/indexer.js";
import { matchesFilters, search } from "../src/core/search/search.js";
import { cosine, searchLike } from "../src/core/search/semantic.js";
import { canonicalJsonLine } from "../src/core/repro/canonical.js";
import { sha256 } from "../src/core/repro/hash.js";
import { MemoryStore, sampleRecord } from "./helpers.js";

describe("tokenizer", () => {
  it("folds German umlauts the way a searcher expects", () => {
    strictEqual(normalizeTerm("Brücken"), "bruecken");
    deepStrictEqual(tokenize("Brücken-Zustand 2024"), ["bruecken", "zustand", "2024"]);
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
