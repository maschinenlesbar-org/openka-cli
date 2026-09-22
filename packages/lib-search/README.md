# @maschinenlesbar.org/openka-lib-search

> Keyword search over the index, and semantic search over vectors the factory froze.

Keyword search parses the query, gathers postings from the shards its terms live in,
applies the structured filters, ranks, and returns catalog rows. No record is loaded
from disk unless a phrase has to be confirmed or a snippet is requested.

**The line never embeds anything.** There is no model to call here, only vectors to
compare. A semantic query therefore has to be a document that already has a vector
(`--like <id>`), or a term whose vector the factory froze into the corpus. That is
the concept's rule, not a limitation of the implementation.

This package also holds `test/store.test.ts`, which covers `lib-store` as well —
the store and the search built on it are tested together because the interesting
assertions span both.

## What is in here

- **`src/search.ts`** — Keyword search over the corpus: parse the query, gather postings from the index shards the query terms live in, apply the structured filters, rank, and return catalog rows.
- **`src/semantic.ts`** — Semantic search over embeddings that were computed in the factory and frozen into the corpus.

## Public surface

Everything is re-exported from the package root:

```
SearchFilters, SearchOptions, SearchHit, SearchResult, matchesFilters, search, makeSnippet, cosine, SemanticOptions, searchLike
```

## Depends on

- `lib-errors` — the shared error hierarchy
- `lib-store` — the corpus seam

## Tests

`test/store.test.ts` — run with:

```bash
npm test -w @maschinenlesbar.org/openka-lib-search
```
