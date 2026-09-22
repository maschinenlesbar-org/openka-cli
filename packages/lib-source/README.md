# @maschinenlesbar.org/openka-lib-source

> The `Source` protocol, and the scraping helpers the connectors share.

A source knows three things and nothing else: where its parliament publishes, how to
page through that publication, and which URLs belong to one Anfrage. It does **not**
extract — extraction is shared and deterministic, and a connector that did its own
would be a second place for a document to be read differently.

This package also holds `SourceEntry`, the shape a connector uses to describe itself
to the registry. It lives here rather than in `lib-registry` because the registry
depends on every connector, and a connector cannot import the package that collects
it.

`html.ts` is not a DOM. It is a small set of deterministic scanners over markup whose
class names are the contract — a fragile contract, and the design says so out loud.
`xml.ts` is a dependency-free reader for the subset the parliamentary exports
actually use; it is not validating and does not pretend to be.

## What is in here

- **`src/base.ts`** — The Source protocol — the "set of clients" layer.
- **`src/html.ts`** — Minimal, deterministic HTML helpers for the one source that has no data feed.
- **`src/xml.ts`** — A small, dependency-free XML reader.

## Public surface

Everything is re-exported from the package root:

```
DocRefDocument, DocRef, DiscoverOptions, DiscoverResult, Source, withDiscoveryState, applyWindow, SourceStatus, SourceEntry, decodeHtml, textOf, visibleTextOf, stripHidden, blocksWithClass, regionWithClass, spanTexts, firstHref, XmlNode, decodeEntities, parseXml, parseXmlFragment, childrenNamed, child, childText, streamElements
```

## Depends on

- `lib-errors` — the shared error hierarchy
- `lib-extract` — the deterministic tier stack
- `lib-http` — the Transport seam and the fetch engine
- `lib-models` — the canonical record schema, validators and the parliament table
- `lib-store` — the corpus seam
- `lib-text` — control-character stripping

## Tests

`test/source.test.ts` — run with:

```bash
npm test -w @maschinenlesbar.org/openka-lib-source
```
