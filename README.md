# openka-cli — `ka`

> German parliamentary *Kleine Anfragen* from 17 incompatible documentation
> systems, in one standardized, reproducible, machine-readable format.
>
> **The runtime is deterministic. No generative model runs in this program.**
> When an extractor cannot read a document it *abstains* and queues it for review.
> A missing fact is recoverable; a fabricated one poisons the corpus.

See [CONCEPT.md](CONCEPT.md) for the design this implements, and
[DEVELOPING.md](DEVELOPING.md) for how it is built.

## Install

```bash
npm install -g @maschinenlesbar.org/openka-cli
```

Two binaries are installed:

| Binary       | Plane   | What it is |
|--------------|---------|------------|
| `ka`         | line    | the deterministic runtime: sync, search, get, verify, review, export |
| `ka-factory` | factory | build-time tooling: the no-model guardrail, golden fixtures, health and drift |

Node ≥ 20. The only required runtime dependency is `commander`; HTTP is
`node:http`/`https`, PDF reading is written here, and the corpus is plain files.

## Quick start

```bash
# Ingest a window of Berlin's Schriftliche Anfragen (question + answer + PDF text)
ka sync --source berlin --since 2024-01-01 --limit 50

# Search it
ka search "Brücken Zustand" --parliament berlin --year 2024
ka show berlin-19-18221

# Get the canonical record, or another rendering of it
ka get berlin-19-18221 --format json     # canonical JSON: the stored bytes
ka get berlin-19-18221 --format md       # readable
ka get berlin-19-18221 --format jsonld   # schema.org

# Prove it: re-run the extraction from the archived bytes and compare
ka verify berlin-19-18221

# See what the extractor refused to answer
ka review

# Bulk output
ka export --format csv --out corpus.csv
ka feed --party GRÜNE --out gruene.atom
```

The corpus lives in `$OPENKA_CORPUS`, or `~/.local/share/openka`, or wherever
`--corpus` points. It is a directory of plain files: content-addressed source
PDFs, one canonical JSON record each, and a JSON index.

## What makes a record trustworthy

Every record carries an `extraction` block that says exactly how to reproduce it:

```jsonc
"extraction": {
  "tier": "text_layer",
  "extractor_version": "pkg:0.0.1",
  "model_artifacts": [],
  "input_sha256": "7d0515afe6e5…",
  "reproducible": true,
  "parse_complete": false,
  "abstained_fields": ["qa[4].answer"],
  "review_status": "needs_review"
}
```

There is no confidence score, because there is no model guessing. There is
`abstained_fields`, which names the holes. `ka verify` re-runs the extraction from
the archived bytes and asserts the output is byte-identical; `ka review` lists the
holes for a human; the archived PDF is the appeal court for any field you doubt.

## Sources

| Source | Parliament | Kind | Notes |
|--------|-----------|------|-------|
| `berlin` | Abgeordnetenhaus von Berlin | structured XML | daily open-data export per Wahlperiode, in the `Parlamentsspiegel Export 1.0` format |
| `bund` | Deutscher Bundestag | structured JSON API | DIP; needs `--api-key` / `DIP_API_KEY` |
| `nordrhein-westfalen` | Landtag NRW | dedicated adapter | discovery via the Parlamentsspiegel (the Landtag's own search is robots-disallowed), with document URLs built from the Drucksachennummer |
| `saarland` | Landtag des Saarlandes | dedicated adapter | unwraps the iframe page the aggregator links to |
| `sachsen` | Sächsischer Landtag | dedicated adapter | walks every document position of the EDAS viewer |
| `thueringen` | Thüringer Landtag | dedicated adapter | looks the answer Drucksache up through Parldok's JSON API |
| `parlamentsspiegel` | all 16 Länder | HTML search | the Länder's shared portal: metadata and PDF links, no API |
| the other 11 Länder | — | via the aggregator | registered with `status: via_aggregator`; `ka sources list` shows the map |

All 17 parliaments are registered. The ones without a dedicated adapter say so
rather than quietly returning nothing — run `ka sources list`.

Coverage is honest, not complete. Across 96 records from eight parliaments, 68
extract completely and 89 yield at least one question/answer pair; the rest abstain and land
in `ka review` rather than in the corpus as half-read records. A record's documents
are all read, not just one — a Land that publishes the question and the answer as
separate papers would otherwise yield every answer and no question.

A record is dated by **when the Anfrage was asked**, not when it was answered — so
`--since`/`--until`, `--year` and `--from`/`--to` all mean the question's date.

### Credentials

Precedence is always **flag > environment variable > none**, and no key is ever
bundled. The Bundestag publishes a public DIP key on
<https://dip.bundestag.de/über-dip/hilfe/api>; personal keys come from
`parlamentsdokumentation@bundestag.de`.

## Tiers, and where a model is allowed

| Tier | Source shape | What runs |
|------|-------------|-----------|
| `structured` | API / XML export | field mapping; highest trust |
| `text_layer` | PDF with a text layer | the PDF reader in `src/core/pdf/`, then frozen segmentation rules |
| `ocr` | scanned / image-only PDF | a pinned, hashed OCR model — or an abstention |

OCR is **off by default** (strict mode: no model on the line at all, at the cost of
coverage on scans). Two engines can be enabled, both version-pinned and both
recording their traineddata hash in `extraction.model_artifacts`:

```bash
ka sync --source berlin --ocr tesseract      # the native binary on PATH
npm install tesseract.js                     # optional peer dependency
ka sync --source berlin --ocr tesseract-js   # the WASM build
```

## Library

```ts
import { extractPdfText, segmentQa, FileStore, sync, BerlinSource } from "@maschinenlesbar.org/openka-cli";

const { text } = extractPdfText(pdfBytes);
const { rules, segments } = segmentQa(text);
```

The whole line is exported: the schema and its validators, the store, the
deterministic extractors, the dependency-free PDF reader, the source clients and
the reproducibility checks. The factory is deliberately *not* exported.

## Licensing

Code is dual-licensed **AGPL-3.0-or-later OR commercial** — see
[LICENSING.md](LICENSING.md). No external code contributions are accepted
([CONTRIBUTING.md](CONTRIBUTING.md)); bug reports and AGPL forks are welcome.

The *data* is not ours. Each upstream has its own terms — see
[DATA_LICENSE.md](DATA_LICENSE.md). We provide the tool, not the data.
