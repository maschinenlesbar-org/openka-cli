# @maschinenlesbar.org/openka-connector-bund

> The Bundestag, through DIP — the cleanest source in the project.

DIP, the Dokumentations- und Informationssystem für Parlamentsmaterialien, is a real
JSON API with filters and cursor pagination, so this adapter is what the concept
calls a trivial deterministic mapper.

**It needs an API key** (`ka config set bund.api-key`, `--api-key`, `DIP_API_KEY`). The Bundestag publishes a
public one and issues personal keys on request. **No key is bundled here.** A key DIP rejects (401/403)
is named as such in the error, with the fix — the Bundestag rotates its public key, so store the
current one with `ka config set bund.api-key` — and the key itself is never quoted.

A Kleine Anfrage is a *Vorgang* with two *Vorgangspositionen*: the question and the
answer. A date window usually splits a pair across its edge, so half-seen pairs are
completed rather than silently filed as unanswered: one query asks for 50 Vorgänge at
once (DIP ORs a repeated `f.vorgang`), the window's own questions first, at most 20
queries a run (1,000 Vorgänge) — beyond that a warning says how many questions were stored
without looking for their answer. A month of 2026 holds ~270 Kleine-Anfrage Vorgänge,
most of them split by the window's edges. A query that reaches to today — a period, or a
window without `--until` — already lists every later answer, so a question alone in it has
no answer yet and is not completed. With `--limit`, only the questions of the Anfragen kept
are completed, and a walk ends as soon as it has read what DIP's `numFound` counts.

**An answer to a question an earlier window stored updates it.** The window filters on the
question's date, so the pair of an answer whose question lies before the window is left
out — unless the corpus holds that question (`DiscoverOptions.store.hasRecord`): then the
pair is kept, and the stored record gets its answer. A daily or weekly sync used to leave
every question unanswered at its first sync unanswered for good. A run cut short by
`--limit` takes no such updates. Without a store to ask (a library caller passing none) such answers are
not completed at all, and one the budget did not reach is left out quietly — it is not a
Vorgang without a question.

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

**A walk stops at 200 pages, and says so.** DIP pages by cursor, 100 documents a page;
discovery walks at most `MAX_PAGES` (200) pages per query. Wahlperiode 19 alone holds
23,384 Kleine-Anfrage positions (234 pages), so `--period 19` reaches the cap: the run
warns that the rest of the window was not discovered and to sync it in parts with
`--since`/`--until`, rather than stopping there without a word. A cursor that changes while its pages bring
no document not already read stops the walk too, with a warning — it used to run all 200
pages.

**One answer per record: the first.** A Vorgang can hold a second "Antwort" position — a
correction or a supplement. The record archives the first by date (then by
Drucksachennummer), whatever order DIP lists them in, and a warning names the others, which
are not archived.

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
