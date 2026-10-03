# @maschinenlesbar.org/openka-lib-search

> Keyword search over the index, and semantic search over vectors the factory froze.

Keyword search parses the query, gathers postings from the shards its terms live in,
applies the structured filters, ranks, and returns catalog rows. No record is loaded
from disk unless a phrase has to be confirmed or a snippet is requested.
`selectRecords` is the bulk counterpart: every match, loaded, plus the ids of catalog
rows whose record file is gone — what `ka export` and `ka feed` work on.

**Filters are checked, not trusted** (`src/filters.ts`). `search()`, `searchLike()` and
`reviewQueue()` run `normalizeSearchFilters` first: parliament keys and parties are
trimmed and lower-cased, dates trimmed; an unknown parliament, a blank party, an
unknown review status, a year outside `YEAR_RANGE` or a period outside `PERIOD_RANGE`,
or a date that is not `YYYY-MM-DD` on the calendar throws `OpenKaValidationError`. A
filter that cannot match used to answer "no matches" — or, for a padded date, switch
the window off. `ka`'s parsers call the same rules. **So is the query**: a non-blank query with no searchable term (`???`, `a`, `-`) is
refused by `search()` (`searchableQueryProblem`) rather than answered with every
record; a blank one still means every record. **So is paging**: `limit` must be an
integer >= 1 and `offset` an integer >= 0 (`assertPaging`, `LIMIT_MIN`, `OFFSET_MIN`;
`limit` defaults to `DEFAULT_SEARCH_LIMIT`, 20), checked by `search()`, `searchLike()`,
`selectRecords()` and `reviewQueue()`; a negative value used to wrap around through
`slice` and return the wrong page.

**The line never embeds anything.** There is no model to call here, only vectors to
compare. A semantic query therefore has to be a document that already has a vector
(`--like <id>`), or a term whose vector the factory froze into the corpus. That is
the concept's rule, not a limitation of the implementation. `searchLike` returns the
same `{ total, hits }` shape as `search()`, with `total` counted before the page is
cut to `limit`.

This package also holds `test/store.test.ts`, which covers `lib-store` as well —
the store and the search built on it are tested together because the interesting
assertions span both.

## What is in here

- **`src/search.ts`** — Keyword search over the corpus: parse the query, gather postings from the index shards the query terms live in, apply the structured filters, rank, and return catalog rows.
- **`src/semantic.ts`** — Semantic search over embeddings that were computed in the factory and frozen into the corpus.

## Public surface

Everything is re-exported from the package root:

```
SearchFilters, SearchOptions, SearchHit, SearchResult, matchesFilters, search, DEFAULT_SEARCH_LIMIT, LIMIT_MIN, OFFSET_MIN, limitProblem, offsetProblem, assertPaging, searchableQueryProblem, YEAR_RANGE, PERIOD_RANGE, intRangeProblem, searchParliamentProblem, reviewStatusProblem, normalizeSearchFilters, SelectOptions, Selection, selectRecords, DEFAULT_REVIEW_LIMIT, ReviewQueueOptions, ReviewQueue, reviewQueue, makeSnippet, cosine, SemanticOptions, searchLike
```

## Depends on

- `lib-errors` — the shared error hierarchy and the validation layer
- `lib-models` — the parliament keys, review statuses and the date rule the filters are checked against
- `lib-store` — the corpus seam

## Tests

`test/store.test.ts` — run with:

```bash
npm test -w @maschinenlesbar.org/openka-lib-search
```
