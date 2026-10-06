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

For many records, `renderJsonLines` writes JSON Lines (one compact canonical record
per line) and `renderJsonLdDocument` one JSON-LD document (an array of the node
objects `renderJsonLd` prints) — what `ka export --format jsonl|jsonld` writes.

`renderAtom` orders its entries newest first (`newestFirst`: the instant each entry
prints, ties on the id) whatever order it is given, and with `limit` keeps the newest
N of the whole set — the selection `ka feed` used to make in its own action.

`renderRecord` refuses a format outside `RENDER_FORMATS` and `renderAtom` a blank
`title` or `id` with `OpenKaValidationError` — an unknown format used to come back as
JSON, a blank title or id as an invalid feed. An omitted title or id is
`DEFAULT_FEED_TITLE` / `DEFAULT_FEED_ID`, the defaults `ka feed` prints.

## Public surface

Everything is re-exported from the package root:

```
RENDER_FORMATS, RenderFormat, renderFormatProblem, renderJson, renderJsonLd, renderJsonLines, renderJsonLdDocument, csvCell, CSV_COLUMNS, csvHeader, renderCsvRow, renderMarkdown, renderText, renderRecord, escapeXml, DEFAULT_FEED_TITLE, DEFAULT_FEED_ID, FeedOptions, atomEntryUpdated, newestFirst, renderAtom
```

## Depends on

- `lib-errors` — the shared error hierarchy and the validation layer
- `lib-models` — the canonical record schema, validators and the parliament table
- `lib-repro` — canonical JSON, hashing and the extractor version stamp
- `lib-text` — control-character stripping

## Tests

`test/render.test.ts` — run with:

```bash
npm test -w @maschinenlesbar.org/openka-lib-render
```
