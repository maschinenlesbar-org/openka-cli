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
npm run stamp       # re-freeze the extraction digest after changing extraction code
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
4. **`extractor_version` names the code that produced the record.** Without it the
   first three are worth little: "same version, different bytes" is the one verdict
   `ka verify` must never have to give, and for a while it did, because the stamp was
   the package version and the package version does not move when extraction does.

### The extraction digest

`extractor_version` is `pkg:<package version>+extract:<digest>` (or whatever
`OPENKA_EXTRACTOR_VERSION` pins in a release build). The digest covers the code that
decides what a document turns into — `src/core/extract`, `src/core/pdf`,
`src/core/perceive` and `src/core/text.ts` — and is frozen in
`src/core/repro/extraction-digest.ts` so the line never reads the source tree at
runtime.

Two choices about *what* is hashed matter more than the hashing:

- **TypeScript sources, not `dist`.** Hashing compiled output would make a `tsc`
  upgrade rewrite the stamp of every record in every corpus, for a change that
  cannot alter a byte of extracted text.
- **Comments and indentation stripped.** `ka verify` compares `extractor_version`,
  so every stored record needs re-syncing whenever the stamp moves. This codebase is
  deliberately comment-heavy; making a better comment invalidate a corpus would
  teach people not to write them.

After changing extraction code run `npm run stamp` and re-freeze the goldens. A test
recomputes the digest and fails until you do — which is the point. An earlier version
of this hashed only the *named* rules (`WORD_GAP_EM`, `MIN_NUMBER_DENSITY`, the
`segment.ts` regexes) and was silently insufficient: keeping control characters out of
record text changed every extraction and moved nothing, because the change was in
ordinary code rather than in a named constant.

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
| Bayern | one document holding the question list, an `Antwort` divider, then the replies | split at the divider |
| Thüringen | the answer is an unrelated Drucksache | looked up through Parldok's JSON API |
| Niedersachsen | the Vorgang exposes only the question | **open** — see below |

Most of those were our own defects and are fixed: two Länder whose combined papers
were mis-roled as questions, one whose follow-up label we did not recognise, and two
whose links pointed at a wrapper page rather than at a document.

**Saarland and Sachsen were not scanned documents.** Both were classified that way
because what we fetched and failed to read was HTML — a 452-byte iframe page from
Saarland, a 1.7 kB frameset from Sachsen's EDAS viewer. Their real PDFs have clean
text layers with no unmapped characters at all. The `ocr` tier was not what either
needed, and no Land has yet been shown to need it.

### Thüringen, and using an undocumented API

Thüringen's answer is a Drucksache with **no relation to the Kleine Anfrage's
number** — 8/979 is answered by 8/1715 — and nothing in the question document names
it either; it is published weeks later.

The Parlamentsspiegel does list it, as a follow-up document. That was read as "the
portal will not render it" for as long as the adapter split a result block on the
`ps-folge` class, which the portal emits only when the search filtered some of a
Vorgang's follow-ups away; an unfiltered row puts the same markup under a bare
`<div >`, and every Thüringen row in the recorded payloads is unfiltered. Since that
was fixed the row yields the answer's Parldok URL, its date and the answering
ministry, and the API lookup below confirms the paper rather than being the only
route to it.

Parldok is a single-page application whose search runs over a JSON API, and the
adapter uses two of its endpoints exactly as the application does:

    Fulltext/Search    find the Kleine Anfrage by kind, number and Wahlperiode
    Process/Document   list the Vorgang's positions, one of which is the answer

Both wrap their payload as a JSON *string* inside a JSON envelope, and both answer
`500` if the request omits defaults the application always sends (`sort`, `topk`).
The facet ids (`kind: 7`, `lp: 10`, `number: 14`) come from the application's own
`pd.facet_*` constants, and the Kleine-Anfrage kind id from its search form.

**This API is undocumented.** It is the site's own public endpoint serving public
documents, and asking it for JSON is gentler than scraping the rendered page — but
nothing promises it keeps its shape. So every unexpected response becomes "no answer
found" with a warning, never a failed sync, and `unwrap()` refuses anything that is
not the exact success shape. A Landtag publishing a documented interface would let
all of this be deleted, which is the point of the project.

### Niedersachsen, and a link recovered by a build-time sweep

Niedersachsen publishes an answered Anfrage as a **new** Drucksache — a combined
paper headed "mit Antwort der Landesregierung" — and that paper names the original
in its header: `Drs. 19/7745`. The link exists; nothing queryable exposes it.

What was checked and ruled out, so it is not repeated:

- **The Parlamentsspiegel** does render it, which this list got wrong for as long as
  the adapter split a result block on the `ps-folge` class: the portal emits that
  class only when the search filtered some of a Vorgang's follow-ups away, and every
  Niedersachsen row in the recorded payloads reads "0 gefiltert/ausgeblendet" and
  puts the same markup under a bare `<div >`. The row names the answer Drucksache,
  its URL, its date and the answering ministry. What it does not do is say that the
  paper reprints the question, which is what the sweep below establishes by reading
  it — so the sweep is a confirmation now, not the only route.
- **`/dokumentensuche/`** (permitted by robots.txt; only `/service/suche/` is
  disallowed) is a TYPO3 browse filter over kind, Wahlperiode and year, with no
  lookup by number and a server-computed `cHash`, so a query it did not generate
  answers 404.
- **NILAS** is a STARWEB install whose entry point 404s from outside.
- **The question documents** do not name their answer; it appears weeks later.

So the link is recovered the only way left: by reading the answers. Every Drucksache
sits at a predictable URL — the outer folder is the number rounded up to a multiple
of 2500, the inner one its 500-wide block, verified across both boundaries — so a
sweep can walk a range, keep the papers that say "mit Antwort der Landesregierung",
and read the `Drs.` each one cites.

That is hundreds of PDFs for one window, which is far too much for a sync and
exactly right for the factory:

    ka-factory answers niedersachsen --period 19 --from 7900 --to 8115 --merge

It freezes a question→answer map as a **corpus artifact** (`artifacts/…json`, the
slot `Store.loadArtifact` reads), stamped with when it ran and which ranges it read.
Those ranges are a *list*, not one from/to pair: `--merge` of two disjoint sweeps
must not claim the numbers between them were read, or a later run skips them and the
map looks complete while being full of holes. `--merge` across legislative periods
is refused outright, since the numbers mean different things in each.
`NiedersachsenSource` consumes it and attaches the answer; without it the source
says so in a warning and yields question-only records, which is honest rather than
wrong. A sweep of 190 Drucksachen found 67 answers and took the Land from no records
with answers to six of eight.

This is the clearest instance in the project of the two planes doing their jobs: an
expensive, messy discovery runs once at build time and ships a frozen artifact; the
line stays a fast, deterministic lookup.

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

**A document can be two halves.** Bayern publishes the question list, then the
single word `Antwort`, then the questions again with the government's reply under
each. Read as one text that is every question asked twice and half of them
answered. When a single document will not read as one text, `splitAtAnswerDivider`
looks for that divider and hands the two halves to the same merge. It is a fallback,
not a first move: a document that reads cleanly as one text is left alone, and the
divider is ignored when nothing above it asks a question — which is what stops the
Bundestag's cover-page `Antwort` (over "der Bundesregierung") from splitting a
document in the wrong place.

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
