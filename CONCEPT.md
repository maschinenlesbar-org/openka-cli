# OpenKA — Kleine Anfragen in a standardized format

> A library, a set of source clients, and a CLI that pull German parliamentary
> *Kleine Anfragen* (and the government's answers) out of 17 incompatible
> documentation systems and emit them as one clean, machine-readable schema.
>
> **The runtime is deterministic. LLMs build and maintain it; they never run in it.**
> Built and maintained mostly autonomously with Claude Code ("dark factory").
>
> **Mission:** defeat the *practical obscurity* of parliamentary data — make information
> that is technically public actually reachable, searchable, and reproducible from
> everywhere (see §11).

*(Names are placeholders: project `openka`, Python package `openka`, CLI `ka`.)*

---

## 0. The core principle: two planes

Everything in this design follows from one rule.

```
┌─────────────────────────────── THE FACTORY (build time) ───────────────────────────────┐
│  LLMs / Claude Code live here.                                                          │
│   • read sample documents, write deterministic extractor code                          │
│   • generate & curate golden fixtures                                                   │
│   • train / retrain perceptual models (OCR, layout, token classifiers)                 │
│   • run the self-healing loop when a source drifts                                      │
│  OUTPUT: frozen artifacts — pinned code + version-hashed model weights.                 │
└───────────────────────────────────────┬─────────────────────────────────────────────────┘
                                         │  ship frozen artifacts (git sha + weight hash)
                                         ▼
┌─────────────────────────────── THE LINE (execution time) ──────────────────────────────┐
│  No generative LLM. No prompts. No model reasoning over content.                        │
│   • pinned deterministic code (parsers, selectors, table rules, validators)            │
│   • pinned perceptual models run with deterministic inference (OCR, layout)            │
│  Same input → byte-identical output, forever. Reproducible, offline, cheap, fast.       │
│  When it can't parse cleanly, it ABSTAINS and queues for human review — never guesses.  │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

Why: these documents feed journalism. A generative model in the runtime path doesn't
just risk being wrong — it produces *plausible* wrong facts and will invent a "question
4" that was never asked. Deterministic code written to fail loudly does the opposite: it
detects when a document doesn't fit its expectations and refuses. **The cost of a
silently changed fact is too high to accept an LLM on the line.**

The R&D robots (LLMs) build and tune the production machines (deterministic extractors);
only the production machines run. That is the dark factory.

---

## 1. Why this is buildable now (and wasn't in 2014–2021)

`kleineAnfragen.de` died for one structural reason: a single volunteer had to
**hand-rebuild scrapers and regex extractors every time a Landtag repainted its
website**, on top of running OCR pipelines that were "more error-prone than you'd
expect." The documents were, and mostly still are, non-machine-readable PDFs — often
Word-typeset or badly scanned — served by two vendors' systems (GLOMAS, j3s) never
designed for open data.

What changed is **not** that we can now let a model read documents at runtime. What
changed is that **an LLM can write and repair the deterministic extraction code — and
train the perceptual models that code depends on — far faster than a human could.** The
maintenance burden that burned out the original maintainer moves onto the machine,
*without* putting a fact-inventing model into the fact-producing path.

So the three bets are:

1. **LLMs author deterministic extractors.** At dev time, Claude reads samples of a
   parliament's documents and emits parser code, selectors, table-region rules, and
   validators. That code is frozen and is what runs.
2. **LLMs generate the ground truth.** Claude proposes golden fixtures (input PDF →
   verified canonical record); humans spot-check; the fixtures become hard regression
   tests. Because the runtime is deterministic, these are real asserts, not fuzzy scores.
3. **LLMs run the repair loop.** When a source drifts (redesign, moved endpoint, new
   layout), the factory regenerates the deterministic extractor, verifies it against the
   goldens, and ships new frozen code. **The exact task that killed the original project
   is now automated — on the build plane, never the runtime plane.**

Design rule that still holds: **prefer official structured sources.** Where an API or
export exists (e.g. the Bundestag DIP API, any OParl endpoints, per-parliament XML
exports feeding the Parlamentsspiegel), the extractor is a trivial deterministic mapper.
Model-based perception (OCR) is reserved for the PDF-only long tail.

---

## 2. Design principles

- **No LLM on the line.** No generative, prompt-driven, content-reasoning model runs at
  execution time. Full stop.
- **Abstain, never guess.** A deterministic extractor that doesn't recognize a document
  emits *nothing* for the affected field and flags it for review. A missing fact is
  recoverable; a fabricated one poisons the corpus.
- **Reproducible by construction.** Every fact traces to `extractor_version` (git sha),
  `model_artifact_hash` (weights of any perceptual model used), and `input_sha256`.
  Re-running yields byte-identical output. This is the trust guarantee.
- **Deterministic ≠ correct, and that's fine.** OCR can misread a character, but it does
  so *reproducibly* and *testably* — errors are systematic, catchable by validators and
  goldens, and fixable by frozen post-processing. That is categorically safer than a
  model that reasons its way to a confident wrong answer.
- **Local-first.** The whole corpus is a SQLite file + a blob store of PDFs. The line
  needs no network to a model provider and runs fully offline.
- **Thin adapters.** Per-source clients hold only genuinely source-specific facts (entry
  URLs, pagination quirks, known gotchas). Shared logic lives in core.
- **Good citizen by default.** Caching, conditional requests, rate limits, robots.txt.

---

## 3. The standardized format (the heart of the project)

One canonical record type, versioned. Pydantic models are the source of truth; JSON
Schema is generated from them for non-Python consumers.

```jsonc
{
  "schema_version": "1.0",
  "id": "be-18-12345",                 // <parliament>-<period>-<ref>
  "parliament": "berlin",
  "document_type": "kleine_anfrage",
  "reference": "18/12345",             // Drucksachennummer as printed
  "legislative_period": 18,
  "title": "Zustand der Brückenbauwerke",
  "askers": [
    { "name": "Erika Mustermann", "party": "SPD", "role": "MdA" }
  ],
  "answered_by": {
    "ministry": "Senatsverwaltung für Umwelt und Verkehr",
    "signatory": "…"
  },
  "dates": { "submitted": "2024-03-01", "answered": "2024-03-28" },
  "qa": [
    { "number": "1", "question": "…", "answer": "…" }
  ],
  "markers": {
    "classified": false,
    "contains_tables": true,
    "attachments_referenced": ["Anlage 1"]
  },
  "full_text": "…",
  "source_documents": [
    {
      "role": "answer_pdf",
      "url": "https://…/dok.pdf",
      "sha256": "…",
      "retrieved_at": "2024-04-02T10:14:00Z",
      "url_stable": false             // e.g. Sachsen: link expires after 15 min
    }
  ],

  // Reproducible provenance — replaces the old model/prompt/confidence block.
  "extraction": {
    "tier": "text_layer",             // structured | text_layer | ocr
    "extractor_version": "sha:9f3c…", // git sha of the adapter+parser that produced this
    "model_artifacts": [              // any perceptual model used at runtime, hashed
      { "name": "ocr", "version": "tesseract-5.3.4", "weights_sha256": "…" }
    ],
    "input_sha256": "…",              // hash of the exact bytes parsed
    "reproducible": true,             // same inputs → same output, verified
    "parse_complete": false,          // did every expected field extract?
    "abstained_fields": ["qa[3].answer"],   // fields the extractor refused to guess
    "review_status": "needs_review"   // ok | needs_review | human_verified
  }
}
```

Key changes from a model-extraction design:
- `extraction` records **exactly how to reproduce the fact**, not how confident a model
  felt. `confidence` is gone; `parse_complete` + `abstained_fields` carry the signal.
- **`abstained_fields` is a first-class output.** A record can be published with holes.
  Holes are honest; invented content is not.
- The raw PDF + `sha256` is ground truth and is **never discarded** — it's the appeal
  court when any extracted field is questioned.

Output renderings from this one record: JSON (canonical), JSON-LD, CSV (flattened,
abstained fields empty and marked), Markdown, and RSS/Atom feeds.

---

## 4. Architecture

Three layers, matching the ask: **library**, **set of clients**, **CLI** — all on the
line (deterministic). The factory (§6, §8) is separate tooling.

```
┌──────────────────────────────────────────────────────────┐
│  ka  (CLI, Typer + Rich)                                  │  ← app  (deterministic)
├──────────────────────────────────────────────────────────┤
│  openka  (core library)                                   │  ← library (deterministic)
│   • models        canonical schema (Pydantic)             │
│   • pipeline      discover → fetch → extract → normalize  │
│   • extract       deterministic tiers (§5), abstain path  │
│   • perceive      pinned OCR/layout models, det. inference│
│   • store         SQLite (+ FTS5) + blob store            │
│   • search        full-text + (optional) precomputed vec  │
│   • repro         hashing, provenance, reproducibility chk│
├──────────────────────────────────────────────────────────┤
│  openka.sources.*  (the "set of clients")                 │  ← clients (deterministic)
│   bund · berlin · bayern · sachsen · nrw · … (17)         │
│   parlamentsspiegel (aggregator adapter)                  │
└──────────────────────────────────────────────────────────┘
        ▲ frozen code + weights shipped from the factory
┌──────────────────────────────────────────────────────────┐
│  factory/  (NOT shipped to the line — build-time only)    │  ← LLMs live here
│   • synth      LLM authors/regenerates extractor code     │
│   • fixtures   LLM proposes goldens; humans verify        │
│   • train      train/eval perceptual models               │
│   • heal       drift detection → regenerate → verify      │
└──────────────────────────────────────────────────────────┘
```

### 4.1 Core library `openka` (the line)

- **`models`** — the schema; enums for the 17 parliaments and doc types.
- **`pipeline`** — `discover() → fetch() → extract() → normalize() → store()`,
  idempotent, keyed on content hash. Pure deterministic composition.
- **`extract`** — the deterministic tier stack (§5) with an explicit abstention path.
- **`perceive`** — the *only* place models run at runtime: pinned OCR / layout /
  segmentation, deterministic inference (fixed weights, argmax/greedy, no sampling),
  version-hashed. Narrow perceptual tasks only; never generative reasoning over content.
- **`store`** — SQLite + FTS5; content-addressed blob store (`blobs/<sha[:2]>/<sha>.pdf`).
- **`search`** — FTS5 keyword; optional semantic search using embeddings **precomputed
  in the factory and frozen** (no runtime embedding calls, or a pinned local embedder).
- **`repro`** — hashing, provenance stamping, and a `verify` routine that re-runs an
  extraction and asserts byte-identical output.

### 4.2 Source clients (`openka.sources.*`) — the "set of clients"

Each parliament is an HTTP **client** of its documentation system, sharing one
interface. Discovery/fetch may be tolerant of messy sites; **extraction is strict.**

```python
class Source(Protocol):
    key: str                          # "berlin"
    def discover(self, since: date | None) -> Iterable[DocRef]: ...
    def fetch(self, ref: DocRef) -> RawDoc: ...       # PDF bytes + inline metadata
    # extraction is shared, deterministic, and adapter-parameterized (rules/selectors)
```

Adapters declare a **tier** so the pipeline knows which deterministic path to run:

| Tier         | Source shape                                | Runtime path (deterministic)              |
|--------------|---------------------------------------------|-------------------------------------------|
| `structured` | API / OParl / DIP / clean XML export         | map fields directly; no perception needed |
| `text_layer` | PDF with a real text layer                   | parse text + layout rules                 |
| `ocr`        | Scanned / image-only PDF                     | pinned OCR → parse; validators; may abstain |

The adapter's parsing rules (selectors, regexes, table-region descriptors) are **written
by the factory and frozen**. Redesigns change discovery/navigation far more often than
they change the deterministic parse of a document, and both are repaired in the factory.

A special **`parlamentsspiegel` adapter** targets the central aggregator (all Länder
already deliver there, partly via XML). If usable, it's the cheapest `structured` source
for many parliaments — try it before per-Landtag scraping.

### 4.3 CLI `ka`

```
ka sync [--source berlin] [--since 2024-01-01]   # deterministic ingest
ka search "Brücken Zustand"                        # FTS
ka search --semantic "marode Infrastruktur"        # frozen embeddings
ka search --party SPD --parliament berlin --year 2024
ka get be-18-12345 --format json|md|csv|jsonld     # standardized record
ka show be-18-12345                                 # pretty render (Rich)
ka open be-18-12345                                 # open archived source PDF
ka verify be-18-12345                               # re-run extraction, assert identical
ka review                                           # work the abstention/needs-review queue
ka export --format csv --out corpus.csv
ka feed --party GRÜNE --out grüne.atom
ka sources list                                     # per-source health + last good sync
```

`ka verify` is new and central: it proves reproducibility on demand. `ka review` surfaces
the honest gaps (abstained fields, unparsed docs) for a human, instead of hiding them
behind machine-generated guesses.

---

## 5. The runtime extraction pipeline (deterministic, with abstention)

For a fetched document, run the tier the adapter declares. Every tier is deterministic;
every tier can abstain.

1. **`structured`** — map API/XML fields to the schema. Pure code. Highest trust.
2. **`text_layer`** — extract the embedded text (`pypdfium2`/`pdfplumber`), apply the
   frozen parse rules (question/answer segmentation, metadata, table regions), run
   validators (e.g. answer date ≥ submission date; every question has an answer or is
   abstained).
3. **`ocr`** — no usable text layer: render pages, run the **pinned OCR model**
   (deterministic inference), apply frozen post-processing (dictionaries, known-entity
   normalization), then the same parse + validators as tier 2.

Abstention rules (the safety mechanism):
- If a region doesn't match the expected structure, **do not** coerce it — emit
  `abstained_fields` and set `parse_complete: false`.
- If validators fail (e.g. a date is impossible, a `qa` pair is malformed), abstain on
  that field and mark `review_status: needs_review`.
- A record may publish with holes. Holes route to `ka review`.

There is no "LLM fallback" tier. When deterministic extraction can't cope, the answer is
**human review now, and a factory job to write a better deterministic extractor later** —
not a runtime guess.

**Reproducibility:** each PDF is extracted once per `extractor_version`; results are
cached by `input_sha256`. Bumping the extractor version triggers controlled
re-extraction, and `ka verify` can re-run any record and assert identical bytes.

---

## 6. Self-healing — on the factory plane only

The original project's death sentence was rebuilding scrapers "from scratch" after every
redesign. The repair loop automates that, but strictly at build time:

```
monitor  → source discover() yields 0, or a golden regresses, or abstention rate spikes
detect   → classify: navigation change? layout change? new pagination? moved endpoint?
synth    → LLM regenerates the affected deterministic code (discovery hints / parse rules)
verify   → run that source's golden fixtures; require ALL pass + no new abstentions
freeze   → bump extractor_version; ship as frozen code (PR; auto-merge only if strictly better)
alert    → if synth fails N times, mark the source degraded in `ka sources list` + reason
```

The runtime never changes behavior on its own — it only ever runs frozen artifacts. A
"self-healing" event is a new frozen `extractor_version`, produced and verified in the
factory, then deployed. The line stays boringly deterministic.

### When is a *trained model* allowed on the line?

Only as a narrow perceptual component, and only under all of these:
- **Deterministic inference:** fixed weights, argmax/greedy decode, no sampling, pinned
  runtime — same input yields the same output.
- **Version-locked & hashed:** a weights change is a reviewed, evaluated release, exactly
  like a code change; the hash lands in `extraction.model_artifacts`.
- **Validated against goldens** and required to **abstain** on low-signal input rather
  than emit a guess.
- **Narrow & perceptual** (OCR, "is this region a table," "is this token a date") — never
  generative reasoning over document content.

OCR is the canonical sanctioned case. Prefer hand-written deterministic code everywhere
else; every runtime model is an audit liability, so minimize them. (Strict mode: forbid
neural runtime components entirely and accept lower coverage on bad scans. This is a
config choice, not a rewrite.)

---

## 7. Being a good citizen

- Conditional requests (ETag / If-Modified-Since); respect `robots.txt`; per-host rate
  limits with backoff.
- Cache everything; never re-fetch an unchanged PDF (hash check).
- Identifiable User-Agent with a contact URL.
- Archive to the Internet Archive / Wayback on ingest, mirroring the original's
  long-term-archive ethic, so records survive the next ministry rename or relaunch.
- Ship the corpus as a downloadable dataset so others don't each re-scrape.

---

## 8. The dark factory: building this with Claude Code

Two senses of "dark factory," now cleanly separated by the two planes: agents **build and
maintain** the line, and the line **runs** deterministically without them.

**Spec-driven.** This file + a `CLAUDE.md` (conventions, commands, guardrails) + one spec
per module. The hardest guardrail to state and enforce: *no code path on the line may
call a generative model.* Add a lint/CI check that fails the build if `openka/**` imports
an LLM client — the factory tooling lives outside that boundary.

**Tests are asserts again.** Because the line is deterministic, extraction has three test
layers, all normal (no fuzzy eval scoring):
- **Determinism tests:** same input → byte-identical output; `ka verify` in CI.
- **Golden regression tests:** verified input→record fixtures per source; must stay green.
- **Coverage/health metrics:** parse-complete rate and abstention rate per source, tracked
  over time as quality signals (not pass/fail, but a synth trigger when they degrade).

**Vertical slices, fanned out.** Land one full slice end-to-end first on a `structured`
source (Berlin's XML) so slice #1 isn't gated on OCR quality. Then fan out one parliament
at a time, each gated by its own goldens. Then take on an `ocr` nightmare (Sachsen) to
prove the hard path — including honest abstention on the pages that won't parse.

**Bounded autonomy.** Agents may: write/regenerate deterministic extractors, add
fixtures, train/eval perceptual models, run the heal loop. Agents may **not** without
review: change `schema_version`, raise rate limits, add a generative model to the line, or
promote an extractor whose goldens regressed or whose abstention rate rose. Tests hit
recorded fixtures, never live parliaments.

**Milestones**

| # | Milestone | Done when |
|---|-----------|-----------|
| 0 | Skeleton: repo, `CLAUDE.md`, schema, storage, empty CLI, the "no-LLM-on-the-line" CI lint | `ka --help`; schema validates; lint green |
| 1 | Golden fixtures + determinism/regression harness (Berlin) | `ka verify` asserts identical output on a known corpus |
| 2 | First vertical slice (Berlin, `structured`) | `ka sync --source berlin` → `ka search` → `ka show` |
| 3 | `text_layer` + `ocr` tiers with pinned OCR + abstention | scanned-PDF path parses or abstains; `ka review` works |
| 4 | Search (FTS + frozen embeddings), feeds, exports | `ka search --semantic`, `ka feed`, `ka export` |
| 5 | Factory heal loop + `ka sources list` degraded states | a simulated redesign auto-regenerates code and re-verifies |
| 6 | Fan-out to all 17 + Parlamentsspiegel adapter | each source has goldens + green regression tests |

---

## 9. Suggested stack

- **Python 3.12+**; **Pydantic v2** (schema + JSON Schema export); **Typer + Rich** (CLI);
  **httpx** (fetching with caching/backoff); **pypdfium2 / pdfplumber** (text + raster);
  **pinned OCR** (e.g. Tesseract or a version-locked neural OCR) run deterministically;
  **SQLite + FTS5** (+ optional `sqlite-vec` with frozen embeddings).
- The factory uses an LLM/Claude Code toolchain that is **not a dependency of `openka`** —
  it produces artifacts the line consumes.
- (TypeScript is viable if consumers are JS-first; the two-plane architecture is
  language-agnostic.)

---

## 10. Repo layout

```
openka/
├── CLAUDE.md                  # conventions, commands, guardrails (incl. no-LLM-on-line rule)
├── CONCEPT.md                 # this file
├── pyproject.toml
├── src/openka/                # THE LINE — deterministic, no generative-model imports allowed
│   ├── models/                # canonical schema + JSON Schema export
│   ├── pipeline/              # discover→fetch→extract→normalize→store
│   ├── extract/               # deterministic tiers + abstention
│   ├── perceive/              # pinned OCR/layout, deterministic inference, hashed weights
│   ├── store/                 # sqlite + blob store
│   ├── search/                # fts + frozen semantic
│   ├── repro/                 # hashing, provenance, verify
│   └── sources/               # the "set of clients", one module per parliament
│       ├── base.py            # Source protocol, DocRef, RawDoc
│       ├── bund.py · berlin.py · sachsen.py · parlamentsspiegel.py · …
├── factory/                   # THE FACTORY — build-time only, NOT a runtime dependency
│   ├── synth/                 # LLM authors/regenerates extractor code
│   ├── fixtures/              # LLM proposes goldens; humans verify
│   ├── train/                 # train/eval perceptual models
│   └── heal/                  # drift detection → regenerate → verify
├── cli/                       # ka (Typer app)
├── fixtures/                  # golden PDFs + verified records, per source
└── tests/                     # determinism + regression + the no-LLM-import lint
```

---

## 11. What we're fighting: practical obscurity

OpenKA's antagonist has a name. **Practical obscurity** is information that is technically
public but effectively inaccessible because it's scattered, unindexed, and
non-aggregatable — each record open on its own, yet no one able to get the *aggregate*
insight across all of them. The term comes from information law (*DOJ v. Reporters
Committee*), and it describes Kleine Anfragen exactly: public per document, unreachable
across 17 systems.

The mechanisms that produce it, whether by intent or by neglect:

- **One-star open data** — a human-readable PDF and nothing more (Berners-Lee's 5-star
  scale), often a scanned or Word-typeset document with no machine-readable layer.
- **Open-washing** — the appearance of openness ("Digitalisierungsinitiativen," agile
  IT-Powerhouses) without releasing data in a form anyone can actually reuse.
- **Data balkanization / non-interoperability** — 16 incompatible Länder systems plus the
  Bund, no shared schema, so nothing composes; harmonization is never attempted.
- **Administrative burden** (Herd & Moynihan) — the learning and effort costs pushed onto
  the citizen who wants their own public information, up to defects like Sachsen's
  15-minute-expiring document links.

**A deliberate honesty note on intent.** These mechanisms *look* like a tactic, and terms
like *obfuscation*, *malicious compliance*, or *transparency theater* fit if intent is
present. But the source interview pointedly resists that reading: Richt calls blame
"difficult," names it *Verschlafen* (sleeping through it) and resignation to outdated
infrastructure, and a commenter identifies **Zuständigkeitsdiffusion** — diffusion of
responsibility, where vendors, administrations, and parliamentarians each point at the
others. The outcome is the same either way, so OpenKA targets the **outcome**, not a
motive: practical obscurity produced by institutional inertia and path dependency. This
framing is precise, citable, and doesn't overclaim a conspiracy.

> **Mission in one line:** OpenKA exists to defeat the *practical obscurity* of
> parliamentary data — to make public information that is technically open actually
> reachable, searchable, and reproducible from everywhere.

---

## 12. Risks & open questions

- **Coverage is honest, not complete.** The long tail of unparseable documents goes to
  human review, not auto-fill. The corpus grows as the factory writes better extractors.
  This is the deliberate tradeoff: fewer facts, but every published fact is real and
  reproducible.
- **OCR is the one audit liability on the line.** It's deterministic but can misread.
  Mitigations: validators, dictionaries, goldens that include scanned pages, and
  abstention on low-confidence regions. Strict mode drops neural OCR entirely at the cost
  of coverage.
- **Factory quality gates everything.** Bad synthesized code or a bad model release could
  regress silently — hence mandatory golden regression + determinism tests before any
  freeze, and abstention-rate monitoring as an early warning.
- **Legal/ToS.** Prefer official APIs/exports; cache aggressively; check each source's
  terms.
- **The Parlamentsspiegel question.** If its promised IT renewal ships or it's
  open-sourced, a large slice of scraping collapses into one `structured` adapter. Design
  so that's a config change, not a rewrite.
- **The structural point stands.** As the article argues, volunteers doing the state's
  infrastructure job changes nothing structurally. Honest framing: OpenKA is a **forcing
  function and a bridge** — proof the data *can* be standardized cheaply *and*
  reproducibly, ideally pressuring parliaments toward real open-data APIs that make it
  unnecessary.
