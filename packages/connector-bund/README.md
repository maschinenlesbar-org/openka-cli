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

**The answering ministry is only taken when DIP marks it.** A Vorgang can list
several `ressort` entries, and only the one flagged `federfuehrend` is the answering
one. With several and none flagged, the adapter names none and says so in a warning
— the ministry is genuinely lost in that case, because a Bundestag answer does not
name it in the document text either.

## Public surface

Everything is re-exported from the package root:

```
DIP_BASE_URL, DIP_API_KEY_ENV, BundDipSource, toRef, askersOf, parseDipAuthor, ENTRY
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
