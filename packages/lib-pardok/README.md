# @maschinenlesbar.org/openka-lib-pardok

> The `Parlamentsspiegel Export 1.0` XML format.

Worth its own package because it is not Berlin-specific: the DTD is the Landtag
NRW's aggregation format, the one the Länder deliver to the Parlamentsspiegel in.
Berlin happens to publish its own feed of it as open data, which is why the only
consumer today is `connector-berlin` — but any Land that starts publishing the
format needs no new parser, only a connector that points at its feed.

The discovery key is namespaced by the field it came from (`VID:`, `VNr:`, `ref:`).
Unprefixed they are all bare digit strings, so a Vorgang identified by its `VNr`
shadowed an unrelated one whose `VID` carried the same digits.

## Public surface

Everything is re-exported from the package root:

```
QUESTION_DOC_TYPES, ANSWER_DOC_TYPES, PardokOptions, pardokVorgangToRef, parsePardokExport
```

## Depends on

- `lib-extract` — the deterministic tier stack
- `lib-models` — the canonical record schema, validators and the parliament table
- `lib-source` — the `Source` protocol and the scraping helpers

## Tests

`test/pardok.test.ts` — run with:

```bash
npm test -w @maschinenlesbar.org/openka-lib-pardok
```

## Fixtures

**Recorded upstream payloads**, so tests never touch a live parliament:

- `fixtures/payloads/pardok-sample.xml`
