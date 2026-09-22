# @maschinenlesbar.org/openka-lib-starweb

> STARWEB — a stateful HTML form, not an API.

Bremen (PARiS), Rheinland-Pfalz (OPAL) and Schleswig-Holstein (e-LISSH) all run
STARWEB. So does Sachsen-Anhalt (PADOKA), whose robots.txt disallows everything and
which is therefore not reached from here at all.

Unlike `lib-parldok`, there is no JSON to ask for. A search is three steps:

1. **GET the search page.** It carries a `__websessionID` and a `__sessionNumber` in
   hidden inputs. A POST without them is answered with the search page again — and
   with no error, which is the worst way for this to fail.
2. **POST every hidden field back**, plus the search fields, plus `__action`: the
   number of the control being "pressed". That number is read from the button's own
   `caSubmit(this,self,'20',…)` call rather than hard-coded, because it is assigned
   per template. Bremen's search is `20`; nothing promises another installation
   agrees.
3. **Parse the result page.** Each hit is one `<tbody name="RecordRepeater">`, and
   STARWEB links the PDF directly, so there is no viewer to resolve.

What lives here is that handshake and the record-block extraction, which are the
same everywhere. What a record's *line* says — where the Drucksachennummer sits,
what the type is called, which chamber filed it — differs per Land and stays in the
connector.

`noHits()` matters more than it looks: it is what lets a connector tell a genuinely
empty window from a template that changed, and only the second is a reason to fall
back to the aggregator.

## Public surface

Everything is re-exported from the package root:

```
StarwebEndpoint, StarwebSession, hiddenFields, actionOf, openSearch, sessionFrom, runSearch, recordBlocks, blockText, pdfHref, recordId, totalHits, noHits
```

## Depends on

- `lib-http` — the Transport seam and the fetch engine
- `lib-source` — the `Source` protocol and the scraping helpers

## Tests

`test/starweb.test.ts` — run with:

```bash
npm test -w @maschinenlesbar.org/openka-lib-starweb
```
