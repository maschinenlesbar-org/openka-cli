# @maschinenlesbar.org/openka-lib-parldok

> Parldok — the parliamentary documentation system several Landtage run.

Thüringen was the first Land here to use it and this client was written inside that
connector. It is not Thüringen-specific: Mecklenburg-Vorpommern runs the same
software, answering the same endpoints with the same JSON envelope, and only the
hosts differ. So the client lives here and a connector supplies its Land's two
addresses as a `ParldokEndpoint`.

```
Fulltext/Search    find documents by kind, number and Wahlperiode
Fulltext/Facets    what values a facet can take at this installation
Process/Document   list a Vorgang's positions, one of which is the answer
```

**The API is undocumented.** It is each site's own public endpoint serving public
documents, and asking it for JSON is gentler than scraping the rendered page, but
nothing promises it will keep its shape. Every response is therefore read into an
`ApiReading` — `found`, `absent`, or `unrecognised` with a reason — so "there is
nothing" and "I do not understand this" stay different facts. Only the second is a
reason to fall back to the aggregator.

**The facet ids are software; the values are data.** `pd.facet_*` is byte-identical
in the Thüringen and MV bundles, so `FACET_KIND`, `FACET_TYPE`, `FACET_TIME`,
`FACET_LP` and `FACET_NUMBER` are shared constants. Which facet holds "Kleine
Anfrage" is not: Thüringen files it under `Dokumentart` (facet 7), while MV's facet 7
is Drucksache/Protokoll and the question type lives under `Dokumenttyp` (facet 8).
Each connector names its own, read from that installation's facet listing rather
than guessed.

**A listing is paged and checked for progress.** `searchDocuments` asks page by page
(`Start`, 200 hits each) until the `count` is reached or a page comes back short; a page
that brings no hit not already listed means the server is ignoring `Start`, and the
listing is `unrecognised` rather than counted again (that once made 200 papers "600
discovered", and without a `count` asked 500 times). A later page that fails (an HTTP 500, a
maintenance page) is asked once more before the listing is given up — one transient
error used to drop every page already read and hand the run to the aggregator.

## Public surface

Everything is re-exported from the package root:

```
ParldokEndpoint, FACET_KIND, FACET_TYPE, FACET_TIME, FACET_LP, FACET_NUMBER, FACET_KIND_MV, KIND_KLEINE_ANFRAGE, searchBody, processBody, ApiReading, successPayload, FoundDocument, firstHit, answerPosition, SearchTag, searchDocumentsBody, searchResults
```

## Depends on

Nothing. This is a leaf of the dependency graph.

## Tests

No tests of its own; exercised through `connector-thueringen` and `connector-mecklenburg-vorpommern`, each against its own recorded payloads.
