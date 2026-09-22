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
daily sync cheap. The format itself is parsed by `lib-pardok`, which is shared.

## Public surface

Everything is re-exported from the package root:

```
BERLIN_OPENDATA_BASE, BERLIN_PERIODS, BERLIN_LATEST_PERIOD, berlinFeedUrl, BerlinSource, ENTRY
```

## Depends on

- `lib-errors` — the shared error hierarchy
- `lib-pardok` — the `Parlamentsspiegel Export 1.0` reader
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
