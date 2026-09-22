# @maschinenlesbar.org/openka-lib-parlamentsspiegel

> The Länder's shared research portal — and the fallback for every Land without an adapter.

The Parlamentsspiegel is run by the Landtag NRW and indexes the parliamentary
business of all 16 Landtage — roughly 984,000 Vorgänge and 2.3 million documents as
of 2026, updated daily. It has no API and, by the portal's own statement, no
document interface: it links to the owning Landtag.

So this adapter parses the `/suche` result markup. **The class names are the
contract**, which means a redesign breaks discovery — the code says so where it
matters, and the fixtures here are what make the breakage visible in CI rather than
in a sync.

Two known traps are pinned by tests:

- **`ps-folge` is only emitted when the search filtered follow-ups away.** A row
  reading "0 gefiltert/ausgeblendet" renders byte-identical markup under a bare
  `<div >`, so splitting on that class silently lost the answer — its Drucksache,
  URL, date and ministry — for every unfiltered row. In the recorded payloads that
  was all of Niedersachsen and all of Thüringen.
- **The answering body comes from the row's own `Urheber` field**, not from the
  summary line. Reading the summary meant guessing where the name began, and
  Thüringen's "Antwort auf Kleine Anfrage. Ministerium für …" yielded a manufactured
  name.

The recorded result rows live here rather than with the Länder because a
Parlamentsspiegel search result is the aggregator's document. A connector that needs
one borrows it with `fixturesOf(...)`.

## Public surface

Everything is re-exported from the package root:

```
PARLAMENTSSPIEGEL_BASE, KLEINE_ANFRAGE_FILTER, ParlamentsspiegelSource, ParlamentsspiegelAllLaender, toGermanDate, documentRole, parseVorgangBlock
```

## Depends on

- `lib-errors` — the shared error hierarchy
- `lib-extract` — the deterministic tier stack
- `lib-models` — the canonical record schema, validators and the parliament table
- `lib-source` — the `Source` protocol and the scraping helpers

## Tests

`test/sources.test.ts` — run with:

```bash
npm test -w @maschinenlesbar.org/openka-lib-parlamentsspiegel
```

## Fixtures

**Recorded upstream payloads**, so tests never touch a live parliament:

- `fixtures/payloads/parlamentsspiegel-niedersachsen.html`
- `fixtures/payloads/parlamentsspiegel-nrw.html`
- `fixtures/payloads/parlamentsspiegel-results.html`
- `fixtures/payloads/parlamentsspiegel-saarland.html`
- `fixtures/payloads/parlamentsspiegel-sachsen.html`
- `fixtures/payloads/parlamentsspiegel-sh.html`
- `fixtures/payloads/parlamentsspiegel-thueringen.html`
