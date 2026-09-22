# @maschinenlesbar.org/openka-lib-store

> The corpus: content-addressed blobs, canonical records, a catalog and an inverted index.

```
<root>/
  blobs/<sha[0:2]>/<sha>.bin   content-addressed source documents
  records/<id>.json            canonical records, one file each
  index/catalog.json           denormalised rows for filtering and listing
  index/tokens/<shard>.json    inverted index shards
```

Everything the line persists goes through the `Store` interface, so the pipeline,
search and the CLI can be driven against an in-memory store in tests without
touching a filesystem — the same trick `Transport` plays for HTTP. The interface is
split into roles (`BlobStore`, `RecordStore`, `CatalogStore`, `IndexStore`,
`SourceStateStore`, `ArtifactStore`, `EmbeddingStore`) so a consumer can ask for the
narrow thing it needs; `Store` is their intersection.

The full-text index replaces SQLite FTS5 from the concept: the line has no runtime
dependencies and Node's built-in SQLite is not available on every supported version.
Tokenizer, scoring and sharding are pure functions, so the ranking of a search
result is reproducible and unit-testable without a filesystem.

Indexing is incremental — adding a record loads only the shards its own tokens live
in, and removing one uses the catalog row to find the same shards again, so a
deletion never scans all 256.

## What is in here

- **`src/file-store.ts`** — The corpus on disk:  <root>/ blobs/<sha[0:2]>/<sha>.bin        content-addressed source documents records/<id>.json                 canonical records, one file each index/catalog.json                denormalised rows for filtering + listing index/tokens/<shard>.json         inverted index shards (256 of them) index/embeddings.json             frozen vectors, only if the factory shipped some state/<source>.json               per-source sync + conditional-request state  Everything is plain JSON in canonical form, so a corpus diffs cleanly in git, can be inspected with `cat`, and — crucially for
- **`src/fts.ts`** — The full-text index: tokenizer, scoring and sharding — all pure functions, so the ranking of a search result is reproducible and unit-testable without touching a filesystem.
- **`src/indexer.ts`** — Keeping the catalog and the inverted index in step with the records.
- **`src/store.ts`** — The corpus seam.

## Public surface

Everything is re-exported from the package root:

```
FileStore, TITLE_BOOST, normalizeTerm, tokenize, shardOf, Posting, IndexShard, termFrequencies, scoreTerm, ParsedQuery, parseQuery, normalizeWithOffsets, containsPhrase, indexableFields, toCatalogEntry, IndexTarget, indexRecord, unindexRecord, reindexAll, CatalogEntry, SourceState, BlobStore, RecordStore, CatalogStore, IndexStore, SourceStateStore, ArtifactStore, EmbeddingStore, Store, EmbeddingSet
```

## Depends on

- `lib-errors` — the shared error hierarchy
- `lib-models` — the canonical record schema, validators and the parliament table
- `lib-repro` — canonical JSON, hashing and the extractor version stamp

## Tests

Its tests live in `lib-search`'s suite (`test/store.test.ts`), which exercises the store and the search built on it together.
