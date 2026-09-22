# @maschinenlesbar.org/openka-connector-nordrhein-westfalen

> The largest Landtag, and the one that runs the Parlamentsspiegel for all sixteen.

**Why this adapter does not talk to the Landtag's own search.** `landtag.nrw.de`
publishes a document search at `/home/dokumente/dokumentensuche/`, and its
robots.txt disallows it. Being a good citizen is a design principle here
(CONCEPT.md §7), not a preference, so discovery goes through the Parlamentsspiegel —
which is allowed, and which the Landtag NRW runs itself.

Document URLs are constructed from the Drucksachennummer rather than followed from
the result row, because the row's link is not always the file.

`ROBOTS_DISALLOWED_PERIODS` is enforced in code: the Landtag's archive is disallowed
for Wahlperioden 11–15, so this adapter will not fetch them however it is asked.

## Public surface

Everything is re-exported from the package root:

```
LANDTAG_NRW_HOST, NRW_ARCHIVE, ROBOTS_DISALLOWED_PERIODS, nrwDocumentUrl, referenceFromNrwUrl, NordrheinWestfalenSource, ENTRY
```

## Depends on

- `lib-errors` — the shared error hierarchy
- `lib-parlamentsspiegel` — the shared aggregator adapter
- `lib-source` — the `Source` protocol and the scraping helpers

## Tests

`test/nordrhein-westfalen.test.ts` — run with:

```bash
npm test -w @maschinenlesbar.org/openka-connector-nordrhein-westfalen
```

## Fixtures

**Goldens** — frozen input→record pairs, verified by `ka-factory goldens verify`:

- `fixtures/nordrhein-westfalen/nordrhein-westfalen-18-13528/` — the record, its metadata and the exact source bytes
