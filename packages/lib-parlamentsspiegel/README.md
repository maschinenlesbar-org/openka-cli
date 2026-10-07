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

**Counting.** Both adapters implement `count()`: one search with the filters discovery
uses, the smallest page the form offers (`size=5`, `page=0`), and the total the page
prints — `<b>69.935</b> <span>Vorgänge</span>`, read by `parseResultCount`
(`fixtures/payloads/parlamentsspiegel-count.html`, recorded 2026-10-06). A page without
it is an error rather than zero. The portal has no Wahlperiode filter, so a `period` is
refused. The Länder whose discovery runs through the portal count through it too, and
Berlin does, instead of downloading its 50+ MB feed per Wahlperiode.

**The portal's `page` parameter counts from 0** (`FIRST_PAGE`): `page=0` is the first
page, and `page=1` the second — the page itself says "Seite 2". Discovery started at
`page=1` until 2026-10-06 and so skipped the newest 50 results of every search; a window
with no more than that came back empty (Saarland, September 2026: 15 Anfragen, none
found). Every Land discovered through the portal is affected, so re-sync recent windows.

The recorded result rows live here rather than with the Länder because a
Parlamentsspiegel search result is the aggregator's document. A connector that needs
one borrows it with `fixturesOf(...)`.

## Public surface

Everything is re-exported from the package root:

```
PARLAMENTSSPIEGEL_BASE, KLEINE_ANFRAGE_FILTER, ParlamentsspiegelSource, ParlamentsspiegelAllLaender, parseResultCount, toGermanDate, documentRole, parseVorgangBlock, undecorated
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

- `fixtures/payloads/parlamentsspiegel-baden-wuerttemberg.html`, `…-bayern.html`,
  `…-hessen.html` — rows of the live portal recorded on 2026-10-05 (exploratory review,
  result 05) and trimmed to the ones that showed the Urheber bugs: "Staatsministerium"
  as an asker, BÜNDNIS 90/DIE GRÜNEN inside a name, an asker with a "(FH)" degree
  dropped
- `fixtures/payloads/parlamentsspiegel-brandenburg.html` — the live answer to `qyHerk=BRA`
  of 2026-10-07, trimmed to three rows (08/3480, 08/3486, 08/3492); documents on
  `www.parlamentsdokumentation.brandenburg.de/starweb/LBB/ELVIS/parladoku/`
- `fixtures/payloads/parlamentsspiegel-niedersachsen.html`
- `fixtures/payloads/parlamentsspiegel-nrw.html`
- `fixtures/payloads/parlamentsspiegel-results.html`
- `fixtures/payloads/parlamentsspiegel-saarland.html`
- `fixtures/payloads/parlamentsspiegel-sachsen.html`
- `fixtures/payloads/parlamentsspiegel-sachsen-anhalt.html` — the live answer to
  `qyHerk=SACA` of 2026-10-07 (exploratory review, result 05), trimmed to three
  unanswered rows: 08/4004 and 08/4010 (one asker), 08/4011 (two Grünen askers);
  documents under `/files/drs/wp8/dkl_anfr/`
- `fixtures/payloads/parlamentsspiegel-sh.html`
- `fixtures/payloads/parlamentsspiegel-thueringen.html`
