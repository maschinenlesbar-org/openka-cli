# @maschinenlesbar.org/openka-connector-sachsen

> Documents behind EDAS, a frameset viewer.

The Parlamentsspiegel links to
`edas.landtag.sachsen.de/viewer.aspx?dok_art=Drs&dok_nr=3284&leg_per=8`, which
returns a 1.7 kB frameset. The file itself lives on a different host under an opaque
name:

```
https://ws.landtag.sachsen.de/images/8_Drs_3284_0_1_1_.pdf
```

That name *looks* constructible — `<period>_<art>_<number>_0_1_1_.pdf` held for every
document checked — but the trailing `_0_1_1_` is not documented anywhere and nothing
says it is invariant. So this adapter **reads the link out of the viewer's own
navigation frame** instead of guessing it. One extra request per document, in
exchange for not inventing a URL.

A Vorgang can list the same document twice (an Antwort and a Berichtigung);
`mergeDuplicates` keeps that from becoming two records.

Sachsen's rows are also the reason `urlIsStable` exists: an EDAS viewer URL is not a
stable address for the document behind it.

## Public surface

Everything is re-exported from the package root:

```
EDAS_HOST, sachsenNavigationUrl, sachsenPositions, sachsenPositionUrl, sachsenPdfUrlFrom, SachsenSource, mergeDuplicates, ENTRY
```

## Depends on

- `lib-errors` — the shared error hierarchy
- `lib-parlamentsspiegel` — the shared aggregator adapter
- `lib-source` — the `Source` protocol and the scraping helpers

## Tests

`test/sachsen.test.ts` — run with:

```bash
npm test -w @maschinenlesbar.org/openka-connector-sachsen
```

## Fixtures

**Goldens** — frozen input→record pairs, verified by `ka-factory goldens verify`:

- `fixtures/sachsen/sachsen-8-3284/` — the record, its metadata and the exact source bytes

**Recorded upstream payloads**, so tests never touch a live parliament:

- `fixtures/payloads/edas-viewer-navigation-pos1.html`
- `fixtures/payloads/edas-viewer-navigation.html`
