# @maschinenlesbar.org/openka-connector-berlin

> Berlin publishes its parliamentary documentation as open data — the only Land that does.

The Abgeordnetenhaus publishes PARDOK as one XML file per Wahlperiode, rebuilt
daily, in the `Parlamentsspiegel Export 1.0` format:

```
https://www.parlament-berlin.de/opendata/pardok-wp19.xml
```

That makes Berlin a `structured` source: every field of a record except the question
and answer texts comes straight out of the export, and the texts come from the one
PDF Berlin publishes per Anfrage — question and answer in the same document, so the
source document's role is `combined_pdf`.

Berlin's instrument is the **Schriftliche Anfrage**, not the Kleine Anfrage. The
record's `document_type` says so.

The whole period is a 50+ MB download, so ETag / If-Modified-Since is what keeps a
daily sync cheap. The validators are kept per window (`berlinFeedKey`: the feed URL
with `since`, `until` and `limit` as its fragment): a 304 says the feed did not change,
not that the window asked for now was handled, and keyed by the URL alone a sync of 2025
after one of 2026 discovered nothing (issue #11). A new window downloads the feed once;
the same window again costs one conditional request. The format itself is parsed by
`lib-pardok`, which is shared.

## Public surface

Everything is re-exported from the package root:

```
BERLIN_OPENDATA_BASE, BERLIN_PERIODS, BERLIN_LATEST_PERIOD, berlinFeedUrl, berlinFeedKey, BerlinSource, ENTRY
```

## Depends on

- `lib-errors` — the shared error hierarchy
- `lib-pardok` — the `Parlamentsspiegel Export 1.0` reader
- `lib-parlamentsspiegel` — the shared aggregator adapter, for `count()`: one request instead of the feed
- `lib-source` — the `Source` protocol and the scraping helpers
- `lib-store` — the corpus seam

## Tests

`test/berlin.test.ts` — run with:

```bash
npm test -w @maschinenlesbar.org/openka-connector-berlin
```

## Fixtures

**Goldens** — frozen input→record pairs, verified by `ka-factory goldens verify`:

- `fixtures/berlin/berlin-19-10006/` — the record, its metadata and the exact source bytes
- `fixtures/berlin/berlin-19-10041/` — the record, its metadata and the exact source bytes
- `fixtures/berlin/berlin-19-10048/` — the record, its metadata and the exact source bytes
- `fixtures/berlin/berlin-19-21204/` — 2025: question numbers run into their text ("1.2.Welche …"), read since issue #9
- `fixtures/berlin/berlin-19-21969/` — 2025: a date with a year at a line start, no longer a question (issue #9)
