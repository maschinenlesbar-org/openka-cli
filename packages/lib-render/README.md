# @maschinenlesbar.org/openka-lib-render

> Renderings of the one canonical record: JSON, JSON-LD, CSV, Markdown and Atom.

Every renderer shares one rule about holes: an **abstained field is rendered as
visibly absent**, never as an empty value that reads like "there was nothing there".
CSV gets an explicit `abstained_fields` column; Markdown says so in words.

Human-facing renderings strip control characters. `json` and `jsonld` deliberately
do not: those must stay byte-identical to what is on disk, which is what `ka verify`
compares. Nothing that goes through the store can carry one anyway — extraction
strips them and `putRecord` refuses them — so the strip is for the other caller,
a library consumer handing a renderer a record it built itself.

## Public surface

Everything is re-exported from the package root:

```
RENDER_FORMATS, RenderFormat, renderJson, renderJsonLd, csvCell, CSV_COLUMNS, csvHeader, renderCsvRow, renderMarkdown, renderText, renderRecord, escapeXml, FeedOptions, atomEntryUpdated, renderAtom
```

## Depends on

- `lib-models` — the canonical record schema, validators and the parliament table
- `lib-repro` — canonical JSON, hashing and the extractor version stamp
- `lib-text` — control-character stripping

## Tests

`test/render.test.ts` — run with:

```bash
npm test -w @maschinenlesbar.org/openka-lib-render
```
