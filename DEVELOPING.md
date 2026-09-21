# Developing openka-cli

This repository implements [CONCEPT.md](CONCEPT.md) in TypeScript. Read the concept
first: it explains *why* the architecture looks like this. This file explains what
is actually here, where the judgement calls live, and what is deliberately absent.

## Commands

```bash
npm install
npm run build       # tsc -> dist/
npm run typecheck   # tsc --noEmit
npm test            # pretest builds, then node --test dist/test/*.test.js
npm start           # runs `ka` from the build
npm run lint:line   # the no-generative-model guardrail
```

One test file: `node --test dist/test/pdf.test.js`. The CLI from source:
`node dist/src/cli/index.js --help`.

## The two planes, as directories

```
src/
  core/         THE LINE — deterministic, no generative model, no factory imports
    models/     canonical schema, validators, JSON Schema, the 17 parliaments
    repro/      canonical JSON, hashing, the extractor version stamp, `ka verify`
    http/       Transport seam + fetch engine (retry, redirects, conditional requests)
    pdf/        a dependency-free PDF reader: lexer, filters, fonts, text assembly
    extract/    the tier stack, the frozen segmentation rules, the validators
    perceive/   the Perceiver seam — the one place a model may run
    store/      the corpus: blobs, records, catalog, inverted index
    search/     keyword search and the frozen-embedding path
    render/     JSON, JSON-LD, CSV, Markdown, Atom
    pipeline/   discover → fetch → extract → normalize → store
  sources/      THE CLIENTS — one adapter per parliament, plus the aggregator
  cli/          `ka`
  factory/      THE FACTORY — build-time only, never imported by the line
fixtures/       golden fixtures (real PDFs + frozen records) and recorded payloads
test/           node:test suites
```

`ka-factory lint` enforces the boundary: nothing under `src/core`, `src/sources`,
`src/cli` or `src/index.ts` may import an LLM client, mention a model provider's
host, or import from `src/factory`. It runs in CI on every push.

## The seams

Three injection points make the whole program testable in-process. No test spawns
a subprocess, touches the network, or reads the clock.

- **`Transport`** (`src/core/http/http.ts`) — one
  `(HttpRequest) => Promise<HttpResponse>` function. Tests inject a scripted one.
- **`Store`** (`src/core/store/store.ts`) — the corpus. `FileStore` is the real
  implementation; `MemoryStore` in `test/helpers.ts` is the test double.
- **`CliDeps`** (`src/cli/io.ts`) — I/O, the store factory, the engine factory, the
  environment and **the clock**. `run()` returns an exit code rather than calling
  `process.exit`.

A fourth, narrower one: **`Perceiver`** (`src/core/perceive/perceiver.ts`), the only
place a trained model may run at execution time.

## Reproducibility, concretely

The claim is "same input → byte-identical output". Three things make it true rather
than aspirational:

1. **Canonical JSON** (`src/core/repro/canonical.ts`). Keys sorted, two-space
   indent, trailing newline. The bytes on disk, the bytes that are hashed and the
   bytes `ka get --format json` prints are the same bytes.
2. **Extraction is a pure function.** Nothing in `src/core/extract/` reads the
   clock, the filesystem or the network. `retrieved_at` travels *with* the fetched
   document; it is recorded at fetch time, not observed during extraction.
3. **`ka verify`** re-runs the extraction from the archived blob and compares. The
   one exception is `review_status: human_verified`, which a person sets and
   re-extraction cannot reproduce; `verify` carries it across and says so.

## The PDF reader

`src/core/pdf/` is a PDF reader written from scratch, because the alternative was a
runtime dependency and because these documents need reading correctly more than
they need reading quickly. What it does and does not do:

- **Object graph** — it does *not* read the cross-reference table. It scans the file
  for `N G obj` headers and expands object streams. Parliament PDFs come from a long
  tail of Word add-ins and print drivers, and the xref is the part most often wrong.
  Scanning is deterministic, order-defined, and recovers files a strict reader rejects.
- **Filters** — Flate (with PNG/TIFF predictors), LZW, ASCIIHex, ASCII85, RunLength.
  An unsupported filter throws; the tier turns that into an abstention.
- **Encrypted documents** — refused outright. There is nothing to salvage.
- **Fonts** — `ToUnicode` first, then a base encoding plus `/Differences` through a
  glyph-name table. Glyph *widths* are read from `/Widths` and `/W`, which is what
  makes word breaks measured rather than guessed.
- **Text assembly** (`text.ts`) — runs are collected with their device positions,
  grouped into lines by baseline, ordered by x, and joined with a space where the
  measured gap exceeds `WORD_GAP_EM`. This is not over-engineering: Berlin's PDFs
  wrap every single text run in its own `BT … ET`, so a reader that treats `ET` as a
  line break turns every document into one word per line.
- **Whitespace** — typographic spaces are folded to a plain space and invisible
  characters are dropped. Not cosmetic: the Bundestag right-aligns question numbers
  with an EN SPACE, so without the fold every rule that looks for a number at the
  start of a line goes blind.
- **Images** — embedded JPEG/JPEG2000/CCITT/JBIG2 streams are handed to the OCR tier
  as-is. Nothing is rasterised, so the `ocr` tier needs no graphics dependency. An
  image that would need rendering is skipped and reported.

`WORD_GAP_EM` and `LINE_TOLERANCE_EM` are **frozen rules**: changing one changes the
bytes of every record produced through this tier, and is an extractor-version bump.

## The segmentation rules

`src/core/extract/segment.ts` holds the rules that turn text into question/answer
pairs. Three families. The first two are both present in Berlin's own corpus; the third is
how the Bundestag prints its answer Drucksachen.

```
frage_antwort                 nummeriert                    antwort_folgt
Frage 1:                      1. Wie viele …?                1. Wie viele …?
Wie viele …?                  a. Und wie viele …?            Es sind vierzehn.
Antwort zu 1:                 Zu 1: Nach Auskunft …          2. Und wie viele …?
Nach Auskunft …               Zu 1 a): Der Senat …           Drei.
```

`antwort_folgt` has no answer heading at all: the question ends at the **last** line
of its block that ends in a question mark, and the rest is the answer. Inferring a
boundary is a weaker move than reading a heading, so that family only applies when
the document contains no answer headings anywhere (`onlyWhenUnmarked`), and it is
refused unless at least `MIN_INFERRED_ANSWER_RATE` of its questions ended up with an
answer — which is what makes it decline a Bundestag answer that reprints the whole
question list before answering anything.

Every rule set is run, the ones that pass their consistency checks are kept, and the
one that recognised the **most questions** wins; ties break on declaration order.
Running all of them matters: one family's answer pattern fires on documents whose
questions it cannot see, and taking that result would publish answers with no
questions attached.

The consistency checks are where the "abstain, never guess" rule becomes code:

- the numbers must include **1** (front matter that numbers itself, like Berlin's
  "19. Wahlperiode", is dropped first);
- the set of numbers must cover at least `MIN_NUMBER_DENSITY` of `1..max` — which
  tolerates an asker who skipped a number, and refuses eleven "questions" spread
  over the range 1..115;
- a bare numbered item may not be a date (`12. November 2021 …` is a sentence);
- at least one answer must have been found, and an *inferred* split must have
  worked for most of the questions.

If no rule set passes, `qa` is abstained and every rejection reason is recorded.

**Measured coverage** on a 60-document Berlin window (2021-11 to 2021-12):
47 parse-complete, 56 with at least one Q/A pair, 4 abstaining on `qa` entirely. The
four are documents dominated by tables, and they land in `ka review` rather than in
the corpus as half-read records.

## Adding a source

1. Implement `Source` in `src/sources/<key>.ts`: `discover()` returns `DocRef`s with
   the metadata the upstream knows for certain and the URLs of its documents.
   Extraction is shared — an adapter never parses a document.
2. Declare a `tier`. Use `structured` when the upstream hands you fields.
3. Register it in `src/sources/registry.ts`.
4. Record a payload under `fixtures/payloads/` and write tests against it. **Tests
   never touch a live parliament.**
5. Sync a window, freeze two or three goldens
   (`ka-factory goldens add <id> --note "what this pins down"`), and check them
   against the PDFs before treating them as ground truth.

If a Land publishes a `Parlamentsspiegel Export 1.0` feed, it needs no new parser —
point `pardok.ts` at the URL, as `berlin.ts` does.

## The factory workflow

```bash
ka-factory lint                              # the guardrail
ka-factory goldens verify                    # the regression suite
ka-factory health --save-baseline            # record where coverage stands
ka-factory drift                             # what changed, and what kind of change
ka-factory embed                             # build the frozen vectors for --like
```

`drift` classifies rather than just alerting, because the repairs differ: discovery
returning nothing points at navigation or a moved endpoint; abstentions spiking
while discovery is fine points at the document layout. A source that fails is shown
as **degraded** in `ka sources list`, with its last error.

An extractor may not be promoted while a golden is red. That is the gate.

## Deliberate omissions

Stated plainly so they are not mistaken for oversights:

- **No SQLite.** `node:sqlite` needs Node ≥ 22.5 and the corpus has to work on
  Node 20. The store is plain files with a sharded inverted index, behind a `Store`
  interface a SQLite implementation can slot into later.
- **No site, no skills, no plugin packaging.** The other repos in this workspace
  ship a bilingual Jekyll site and Claude Code skills; this one does not yet.
- **No real semantic embeddings on the line.** `ka-factory embed` builds hashed
  TF-IDF projections and says so. Language-model vectors can be imported with
  `--from`; the line still only ever compares numbers.
- **The Parlamentsspiegel adapter is a scraper.** Its markup class names are the
  contract. That is fragile by nature, and the design makes the fragility visible:
  a redesign yields zero results, which is the drift signal, not wrong data.
