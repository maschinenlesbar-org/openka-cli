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
pairs. Three families, and a Land can use more than one heading style within a family. The
first two are both present in Berlin's own corpus; the third is how the Bundestag
prints its answer Drucksachen; a fourth reads `Frage N:` questions whose answer
follows directly, which is how Sachsen's ministries write their replies. Several
Länder use the numbered family with their own answer heading: Schleswig-Holstein writes a bare `Antwort:`, Sachsen-Anhalt writes
`Antwort auf Frage N:`, and Mecklenburg-Vorpommern answers letter sub-items with
`Zu a)`. Bayern numbers its questions hierarchically (`1.1`, `2.3`).

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
- a bare numbered item may not jump more than `MAX_NUMBER_SKIP` ahead of the list:
  "101. Arbeits- und Sozialministerkonferenz", wrapped from the sentence above it in
  a Schleswig-Holstein answer, is prose, not question 101;
- a hierarchical number (`1.1`, Bayern's style) needs no trailing dot, but each of
  its levels is one or two digits: looser, and a date (`02.08.2024`) or a
  thousands-separated figure (`1.154.000`) at the start of a line becomes a question;
- a list of `LARGE_QUESTION_LIST` or more items must have `MIN_ANSWER_RATE_LARGE` of
  them answered. Numbered tables are the hazard here: one SH answer asks six
  questions and then lists 160-odd numbered rows of schools and swimming pools, and
  every check but this one is satisfied by them;
- at least one answer must have been found, and an *inferred* split must have
  worked for most of the questions.

If no rule set passes, `qa` is abstained and every rejection reason is recorded.

**Grouped answers.** Governments answer several questions at once — "Die Fragen 1
und 2 werden aufgrund des Sachzusammenhangs gemeinsam beantwortet." The answer then
sits under the last of the grouped questions and the earlier ones look unanswered.
`groupedAnswerNumbers` reads that sentence from the opening of an answer and
attaches the answer to every number it names, but **only to numbers the document
already showed us** — a grouped sentence naming a question that has no heading
anywhere is a misread of the sentence, not the discovery of a question.

**Measured coverage.** On a 60-document Berlin window (2021-11 to 2021-12):
47 parse-complete, 57 with at least one Q/A pair, 2 abstaining on `qa` entirely —
documents dominated by tables, which land in `ka review` rather than in the corpus
as half-read records. On an 8-document NRW window (2025-03 to 2025-04): 6
parse-complete, 7 with Q/A pairs. On a 6-document Schleswig-Holstein window
(2025-01 to 2025-06): 2 parse-complete, 4 with Q/A pairs, up from none at all.

## Nordrhein-Westfalen, and what discovery is allowed to do

NRW is the first dedicated Land adapter and it is worth reading as a worked example,
because the constraint that shaped it is a legal-ish one rather than a technical one.

The Landtag NRW publishes **no API and no open-data feed**, and its own document
search at `/home/dokumente/dokumentensuche/` is **disallowed by its robots.txt**.
Being a good citizen is a design principle (CONCEPT.md §7), so discovery runs through
the Parlamentsspiegel — which is allowed, and which the Landtag NRW itself operates.
What the adapter adds is everything downstream of discovery:

- **Document URLs are constructed, not scraped.** `18/14035` is
  `…/dokumentenarchiv/Dokument/MMD18-14035.pdf`. A record therefore does not depend
  on the aggregator's link markup, and a disagreement between the constructed URL
  and the scraped one becomes a warning instead of a broken record.
- **The robots.txt boundary is enforced in code.** The archive is disallowed for the
  11th–15th Wahlperiode; asking for one of those is an error, not a request we send
  anyway.

Building it surfaced three defects in the shared aggregator, all of which had been
silently costing whole Länder:

1. **A hidden date.** Each result row carries a `d-none` span with the *newest*
   document's date — usually the answer's. Reading the row's full text dated every
   question by its answer, so any `--since`/`--until` window excluded exactly the
   records it was meant to include. `visibleTextOf` drops hidden elements first, and
   `stripHidden` counts nesting, because a lazy regex stops at the first `</span>`
   and leaves the date behind.
2. **A free-text query.** The portal's own quick link sends `query=Anfrage` on top of
   the structured filters. Sachsen returns 50 results without it and none with it.
   It is gone.
3. **The wrong date.** `applyWindow` filtered on the answer's date. A record is dated
   by **when the Anfrage was asked** — that is its own date, and it is what every
   upstream filters on. `CatalogEntry.year` and the `--from`/`--to` search filters
   follow the same rule.

Before the fixes, four Länder discovered nothing at all. After them, 14 of 15 do —
Bremen genuinely has no Kleine Anfragen in the Parlamentsspiegel for the windows
tried, and Thüringen's rows carry no Drucksachennummer, which is still open.

## Document roles, and why they are read rather than assumed

A Vorgang's documents are not always what their position suggests, and the role a
document is given decides which one the extractor reads.

- **Nordrhein-Westfalen** lists the question and links the answer as a follow-up:
  `question_pdf` + `answer_pdf`.
- **Schleswig-Holstein** files the Vorgang under "Antwort" and publishes the Kleine
  Anfrage *and* the reply as a single Drucksache. Its Fundstelle says so — "Kleine
  Anfrage Birte Pauls (SPD) und Antwort MSJFSIG" — so the row is read, not assumed,
  and the document is a `combined_pdf`. **Baden-Württemberg** is the same shape,
  which is why it scores well while having no separate answer document at all.
- **Brandenburg**'s follow-up row is the answer alone: `answer_pdf`.

`documentRole()` makes that decision from the row and the Fundstelle. The date
follows from it: for a combined paper the one printed date is when the combined
paper appeared, so it is the *answer's* date, and the question's own date is simply
not in the row. Leaving `submitted` unset is the honest reading.

### Why each Land gets its answers, or does not

The sixteen were classified one by one against the aggregator's markup and their
own documents. The result is worth keeping, because "no answers found" turned out
to mean four different things:

| Land | shape | state |
|------|-------|-------|
| BW, MV, Sachsen-Anhalt, SH | one Drucksache holding question *and* answer | read as `combined_pdf` |
| Brandenburg, Hessen, NRW, RLP, Saarland | answer linked as a follow-up document | read as `answer_pdf` |
| Sachsen | the link is a frameset viewer holding several documents | each position resolved through the viewer's navigation frame |
| Saarland | the link is an HTML page whose iframe holds the file | rewritten to the endpoint the wrapper names |
| Bayern, Niedersachsen, Thüringen | the Vorgang exposes only the question | the answer is not reachable through the aggregator |

Most of those were our own defects and are fixed: two Länder whose combined papers
were mis-roled as questions, one whose follow-up label we did not recognise, and two
whose links pointed at a wrapper page rather than at a document.

**Saarland and Sachsen were not scanned documents.** Both were classified that way
because what we fetched and failed to read was HTML — a 452-byte iframe page from
Saarland, a 1.7 kB frameset from Sachsen's EDAS viewer. Their real PDFs have clean
text layers with no unmapped characters at all. The `ocr` tier was not what either
needed, and no Land has yet been shown to need it.

Bayern, Niedersachsen and Thüringen remain genuinely out of reach: the answer exists
upstream but the Parlamentsspiegel does not render it in the result row.

## Reading more than one document

A record's documents are all read, not just one, because a Land that publishes the
question and the answer as separate papers — Saarland does — otherwise yields a
record with every answer and no question at all. The answer paper does not
necessarily reprint the questions; the Bundestag's and NRW's do, Saarland's does not.

The merge is deliberately plain. Each document is segmented on its own, then:

- questions come from a `question_pdf` or `combined_pdf`, first one wins;
- answers come from an `answer_pdf` or `combined_pdf`, first one wins;
- the merged set is checked with **the same consistency rules** a single reading has
  to pass, via `checkSegments`.

That last point is what makes it safe to segment a question paper permissively.
A paper with no answers cannot pass the answer-shaped checks, so those are deferred
(`requireAnswers: false`) and run once on the merged result instead of being
skipped. A numbered table in a question paper is still caught, just later.

Two consequences worth knowing:

- **Parse order is fixed** — `question_pdf`, then `combined_pdf`, then `answer_pdf`,
  ties broken by URL. `full_text` and `input_sha256` therefore do not depend on the
  order discovery happened to list the documents in.
- **`input_sha256` covers everything parsed.** With one document it is that
  document's digest; with several it is a digest over their digests in parse order,
  so the stamp still names exactly the bytes the record came from.

Saarland went from 0 of 4 records with questions to 3 of 4 complete when this
landed, and two Bundestag goldens changed because their questions now come from the
question paper rather than from the answer's reprint of it.

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
