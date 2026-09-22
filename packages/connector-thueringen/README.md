# @maschinenlesbar.org/openka-connector-thueringen

> The Landtag's own Parlamentsdokumentation, with the aggregator only behind it.

Thüringen runs **Parldok**; the client is shared with Mecklenburg-Vorpommern in
`lib-parldok` and only the hosts differ.

Unlike MV, Thüringen publishes the question and the answer as **two** Drucksachen
with no relation between their numbers — 8/979 is answered by 8/1715 — and nothing
in the question document names the answer; it appears weeks later. So discovery and
the answer lookup are two steps:

1. a **listing search** for the Kleine Anfragen of a window (Dokumentart facet 7,
   id `5`, 21,738 documents), which returns each hit *and* the query id;
2. one `Process/Document` per hit, which lists the Vorgang's positions — one of
   which is the answer.

The listing already carries the document id and the query id, so an answer costs
**one** request rather than the two the aggregator path needed (a search by number,
then the Vorgang). `/ParlDok/dokument/<id>/<slug>` serves the PDF directly.

The answer Drucksache reprints the question above the reply, so it is attached as a
`combined_pdf` beside the question's own paper.

**A Vorgang nobody has answered yet still has a position about the answer**:
"Gedruckte Antwort liegt noch nicht vor/wird noch erfasst". It matches "Antwort" and
has no document, and reading that as an answer we failed to follow reported every
open Kleine Anfrage as an API we no longer understand. `lib-parldok` recognises the
phrase and calls it absent.

**The API is undocumented.** A response in an unfamiliar shape is reported as
`unreadable`, which is what sends `createSource()`'s `FallbackSource` to the
Parlamentsspiegel — never an empty window, which is an answer.

`robots.txt` on `parldok.thueringer-landtag.de` is a 404, so nothing here is
disallowed; these are the requests the site's own search page makes.

## Public surface

Everything is re-exported from the package root:

```
PARLDOK_API, PARLDOK_WEB, THUERINGEN_LATEST_PERIOD, KIND_KLEINE_ANFRAGE_TH, ThueringenParldokSource, toRef, parseAuthors, createSource, ENTRY
```

## Depends on

- `lib-extract` — the deterministic tier stack
- `lib-models` — the canonical record schema, validators and the parliament table
- `lib-parlamentsspiegel` — the shared aggregator adapter
- `lib-parldok` — 
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

- `fixtures/payloads/parldok-listing.json`
- `fixtures/payloads/parldok-process.json`
- `fixtures/payloads/parldok-search.json`
