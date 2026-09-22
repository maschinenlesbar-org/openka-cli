# @maschinenlesbar.org/openka-connector-saarland

> A Land that looked like a source of scanned PDFs, and was not.

The Parlamentsspiegel links to `landtag-saar.de/Drucksache/Af17_1326.pdf`, which is
**not** the PDF. It is an HTML page whose whole body is an iframe:

```html
<iframe src='/Downloadfile.ashx?FileId=-1&FileName=Af17_1326.pdf'></iframe>
```

Fetching the link therefore stored 452 bytes of HTML as "the document", and the
extractor then reported, correctly, that it found no text. That is how this Land
spent a whole classification pass looking like a source of scans when its documents
are ordinary text-layer PDFs.

So each document URL is rewritten to the `Downloadfile.ashx` endpoint the wrapper
itself names. The test pins that rewrite, and pins that it is applied to *every*
document of *every* discovered ref — the bug the first fix missed.

## Public surface

Everything is re-exported from the package root:

```
LANDTAG_SAAR_HOST, saarlandDocumentUrl, SaarlandSource, ENTRY
```

## Depends on

- `lib-parlamentsspiegel` — the shared aggregator adapter
- `lib-source` — the `Source` protocol and the scraping helpers

## Tests

`test/saarland.test.ts` — run with:

```bash
npm test -w @maschinenlesbar.org/openka-connector-saarland
```

## Fixtures

**Goldens** — frozen input→record pairs, verified by `ka-factory goldens verify`:

- `fixtures/saarland/saarland-17-1330/` — the record, its metadata and the exact source bytes
- `fixtures/saarland/saarland-17-1331/` — the record, its metadata and the exact source bytes
