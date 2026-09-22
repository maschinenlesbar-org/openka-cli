# @maschinenlesbar.org/openka-connector-thueringen

> Question and answer in one Vorgang, published as two unrelated Drucksachen.

The answer's Drucksachennummer has no relation to the question's — 8/979 is answered
by 8/1715 — and nothing in the question document names it; it is published weeks
later.

Parldok is a single-page application whose search runs over a JSON API, and this
adapter uses two of its endpoints exactly as the application does:

```
Fulltext/Search    find the Kleine Anfrage by kind, number and Wahlperiode
Process/Document   list the Vorgang's positions, one of which is the answer
```

**That API is undocumented.** It is the site's own public endpoint serving public
documents, and asking it for JSON is gentler than scraping the rendered page, but
nothing promises it will keep its shape. So every response is read into an
`ApiReading`: `found`, `absent`, or `unrecognised` with a reason. All three end the
lookup with no answer and none fails the sync — but "Parldok holds nothing" and
"Parldok said something we do not understand" are different facts, and only the
first used to be reported. An HTML maintenance page was being announced as a missing
Drucksache.

The Parlamentsspiegel row also lists the answer, which this package's notes once
denied; the API confirms the paper rather than being the only route to it. Keeping
Parldok is a deliberate choice: the aggregator is a third party, and the Land's own
interface is the better source for the Land's own documents.

## Public surface

Everything is re-exported from the package root:

```
PARLDOK_API, PARLDOK_WEB, FACET_KIND, FACET_LP, FACET_NUMBER, KIND_KLEINE_ANFRAGE, searchBody, processBody, ApiReading, successPayload, FoundDocument, firstHit, answerPosition, ThueringenSource, ENTRY
```

## Depends on

- `lib-models` — the canonical record schema, validators and the parliament table
- `lib-parlamentsspiegel` — the shared aggregator adapter
- `lib-source` — the `Source` protocol and the scraping helpers

## Tests

`test/thueringen.test.ts` — run with:

```bash
npm test -w @maschinenlesbar.org/openka-connector-thueringen
```

## Fixtures

**Goldens** — frozen input→record pairs, verified by `ka-factory goldens verify`:

- `fixtures/thueringen/thueringen-8-980/` — the record, its metadata and the exact source bytes

**Recorded upstream payloads**, so tests never touch a live parliament:

- `fixtures/payloads/parldok-process.json`
- `fixtures/payloads/parldok-search.json`
