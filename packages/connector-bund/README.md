# @maschinenlesbar.org/openka-connector-bund

> The Bundestag, through DIP — the cleanest source in the project.

DIP, the Dokumentations- und Informationssystem für Parlamentsmaterialien, is a real
JSON API with filters and cursor pagination, so this adapter is what the concept
calls a trivial deterministic mapper.

**It needs an API key** (`--api-key`, `DIP_API_KEY`). The Bundestag publishes a
public one and issues personal keys on request. **No key is bundled here.**

A Kleine Anfrage is a *Vorgang* with two *Vorgangspositionen*: the question and the
answer. A date window usually splits a pair across its edge, so half-seen pairs are
completed with a per-Vorgang request rather than silently filed as unanswered.

**Before 1976 there are no Vorgänge.** DIP's procedure records start with the 8th
Wahlperiode (the Bundestag first sat on `FIRST_VORGANG_DATE`, 1976-12-14); the 2,747
Kleine Anfragen of the 1st to 7th exist only as Drucksachen. A `--period` up to 7, or a
window that ends before that day (`drucksacheWindow`), is discovered from
`/api/v1/drucksache?f.drucksachetyp=Kleine Anfrage` instead (`drucksacheRef`): one
question-only ref per Drucksache, with its number, date, askers and PDF. DIP links no
answer to them — no Vorgang, no reference, checked on WP 7 on 2026-10-06 — so none is
paired, and the record says its answers are missing rather than guessing a pairing by
number or title; a warning says so. A discovery that reaches before 1976 on the Vorgang
path warns that those periods are not in it. In the 1st Wahlperiode the instrument was
also typed plain "Anfrage" (241 Drucksachen from 1950); those are not taken, since
nothing here can tell which of them were Kleine Anfragen. `count()` asks the
Drucksachen for those periods too.

**The answering ministry is only taken when DIP marks it.** A Vorgang can list
several `ressort` entries, and only the one flagged `federfuehrend` is the answering
one. With several and none flagged, the adapter names none and says so in a warning
— the ministry is genuinely lost in that case, because a Bundestag answer does not
name it in the document text either.

## Public surface

Everything is re-exported from the package root:

```
DIP_BASE_URL, DIP_API_KEY_ENV, FIRST_VORGANG_DATE, LAST_PERIOD_WITHOUT_VORGAENGE, drucksacheWindow, BundDipSource, toRef, drucksacheRef, askersOf, parseDipAuthor, ENTRY
```

## Depends on

- `lib-errors` — the shared error hierarchy
- `lib-extract` — the deterministic tier stack
- `lib-models` — the canonical record schema, validators and the parliament table
- `lib-source` — the `Source` protocol and the scraping helpers

## Tests

`test/bund.test.ts` — run with:

```bash
npm test -w @maschinenlesbar.org/openka-connector-bund
```

## Fixtures

**Goldens** — frozen input→record pairs, verified by `ka-factory goldens verify`:

- `fixtures/bund/bund-21-7449/` — the record, its metadata and the exact source bytes
- `fixtures/bund/bund-21-7452/` — the record, its metadata and the exact source bytes

**Recorded upstream payloads**, so tests never touch a live parliament:

- `fixtures/payloads/dip-vorgangsposition.json`
- `fixtures/payloads/dip-drucksache-wp7.json` — two Kleine Anfrage Drucksachen of the 7th Wahlperiode (recorded 2026-10-06)
