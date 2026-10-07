# openka-cli — `ka`

German parliamentary *Kleine Anfragen* from 17 incompatible documentation systems,
in one standardized, reproducible, machine-readable format — fetched from the
parliament that published them, read deterministically, and stored as a record you
can re-derive from the archived bytes.

> **The runtime is deterministic. No generative model runs in this program.**
> When an extractor cannot read a document it *abstains* and queues it for review.
> A missing fact is recoverable; a fabricated one poisons the corpus.

See [CONCEPT.md](CONCEPT.md) for the design this implements, and
[DEVELOPING.md](https://github.com/maschinenlesbar-org/openka-cli/blob/main/DEVELOPING.md) for how it is built.

## Install

```bash
npm install -g @maschinenlesbar.org/openka-cli
```

Two binaries are installed:

| Binary       | Plane   | What it is |
|--------------|---------|------------|
| `ka`         | line    | the deterministic runtime: sync, search, get, verify, review, export |
| `ka-factory` | factory | build-time tooling: the no-model guardrail, golden fixtures, health and drift |

Requires Node.js 22.12+. The only required runtime dependency is `commander`; HTTP is
`node:http`/`https`, PDF reading is written here, and the corpus is plain files.

**Install with npm.** The package carries its own workspace packages as
`bundleDependencies`, which npm installs from the tarball. bun resolves them from the
registry instead, where they do not exist, and fails; yarn and pnpm are untested.

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

**The documents can live elsewhere.** The archived PDFs are the bulk of a corpus; the
records and the index are small. `--blobs <dir>` (or `OPENKA_BLOBS`) keeps the PDFs in
a directory of their own — on an external drive, say — while the database stays on the
internal disk, searchable when the drive is unplugged. That directory must exist; it is
never created, so a missing drive cannot turn into a folder on the internal disk.
Without it, `sync`, `open` and `verify` exit 3 ("blob store … is not available"); `search`,
`get`, `show`, `export`, `feed`, `stats` and `review` work as before. A symlinked
`<corpus>/blobs` works too.

**Not on FAT32 or exFAT.** The corpus is often the only copy of what it archived, and
these filesystems have no journal and no extended attributes — macOS writes a `._<name>`
companion beside every file — and FAT32 caps a directory at 65,534 entries, about
8,000–16,000 records. `ka sync` refuses a corpus or `--blobs` directory on either before
it writes anything (exit 3), unless you pass `--allow-fs fat32` or `--allow-fs exfat`;
it warns on a network filesystem. `ka` skips the `._*` and `.DS_Store` files it finds,
and `ka doctor --fix` (or `dot_clean <corpus>`) removes them. APFS, HFS+ and ext4 have
none of these problems.

**Not past a full disk.** `ka sync` keeps 1 GB free on each volume it writes to
(`--min-free 20G` for more, `--min-free 0` to turn it off). It refuses to start below
that floor, and also when the documents still to fetch would not fit. Their size is
estimated from what the source already archived. While it runs, it checks before each
Anfrage and stops cleanly once a volume drops below the floor, keeping what it stored
(exit 3). `ka sync --dry-run` says whether a window's download fits, and `ka doctor`
shows the filesystem, the free space, the lock and whether the catalog matches the
records.

## What makes a record trustworthy

Every record carries an `extraction` block that says exactly how to reproduce it:

```jsonc
"extraction": {
  "tier": "text_layer",
  "extractor_version": "pkg:0.0.1+extract:0c6b4abc448b",
  "model_artifacts": [],
  "input_sha256": "7d0515afe6e5…",
  "reproducible": true,
  "parse_complete": false,
  "abstained_fields": ["qa[4].answer"],
  "review_status": "needs_review"
}
```

The `+extract:` suffix is a digest of the extraction sources, so a rule change moves
the version even when the package version does not.

There is no confidence score, because there is no model guessing. There is
`abstained_fields`, which names the holes. `ka verify` re-runs the extraction from
the archived bytes and asserts the output is byte-identical — for what is read from
the documents; the discovery metadata (title, askers, dates, ministry, document URLs)
is taken from the record and not checked, and `verify` says so. `ka review` lists the
holes for a human; the archived PDF is the appeal court for any field you doubt.

## Sources

Every parliament publishes differently, so every connector is different. The table
is the overview; each connector's `README.md` under `packages/connector-<land>/` has
the detail, the fixtures and the tests for that Land.

**Discovery** is where the list of Anfragen comes from. *Own* means the parliament's
own interface; *aggregator* means the [Parlamentsspiegel](https://www.parlamentsspiegel.de/),
the Länder's shared portal run by the Landtag NRW. **Fallback** is what runs when the
own interface throws or answers in a shape the connector does not recognise — never
when it simply returns nothing. **Tier** is the extraction path the record declares.
Whatever the source, every document is checked against its host's `robots.txt` before
it is fetched; `--ignore-robots` overrides that, never silently.

| `--source` | Parliament | Discovery | Tier | Documents per record | Fallback | Specific to this Land |
| --- | --- | --- | --- | --- | --- | --- |
| `bund` | Deutscher Bundestag | **own** — DIP JSON API (`dip.bundestag.de`), cursor-paged | structured | question PDF + answer PDF (two Drucksachen of one Vorgang) | — | needs `--api-key` / `DIP_API_KEY`; half-seen pairs are completed with a per-Vorgang request; Wahlperioden 1–7 (before 1976-12-14) have no Vorgänge and come from the Drucksachen, question only (`--period 1` … `7`) |
| `berlin` | Abgeordnetenhaus von Berlin | **own** — PARDOK open-data XML, one file per Wahlperiode in the `Parlamentsspiegel Export 1.0` format | structured | one combined PDF | — | 50+ MB per period, kept cheap by ETag / If-Modified-Since; the instrument is the *Schriftliche* Anfrage |
| `bayern` | Bayerischer Landtag | **own** — RSS feed `Drucksachen von Anfragen` plus the static Drucksache PDF | text_layer | one combined PDF | aggregator | the feed mixes Schriftliche Anfragen with Anfragen zum Plenum; each is tested by a HEAD against the `…/Drucksachen/Schriftliche Anfragen/` path, where 404 means "not this instrument". No dates are claimed from the feed, so `--since`/`--until` are refused as a usage error rather than ignored — sync without a window and filter the corpus with `--from`/`--to` |
| `bremen` | Bremische Bürgerschaft | **own** — PARiS, a STARWEB session form (`lib-starweb`) | text_layer | question PDF | aggregator | type is selected through `Dokumenttyp` (Vorgangstyp silently matches nothing); only the Land chamber, not the Stadtbürgerschaft; the result line names the Fraktion, not the members, so no askers are invented |
| `mecklenburg-vorpommern` | Landtag Mecklenburg-Vorpommern | **own** — Parldok JSON API (`lib-parldok`) | text_layer | one combined PDF (`Kleine Anfrage und Antwort` is one Dokumenttyp) | aggregator | the result row already carries asker, Fraktion and answering ministry; the API is undocumented, so an unfamiliar shape is reported as unreadable, not as an empty Land |
| `thueringen` | Thüringer Landtag | **own** — Parldok JSON API: one listing search, then one Vorgang lookup per hit | structured | question PDF + the answer as a combined PDF | aggregator | the answer is a Drucksache with no numeric relation to the question (8/979 is answered by 8/1715); "Antwort liegt noch nicht vor" is read as *unanswered*, not as an API change |
| `nordrhein-westfalen` | Landtag Nordrhein-Westfalen | **aggregator** — the Landtag's own search is robots-disallowed, and it runs the aggregator itself | structured | question PDF + answer PDF | — | document URLs are *constructed* from the Drucksachennummer (`MMD18-14035.pdf`) rather than scraped; Wahlperioden 11–15 are refused because robots.txt disallows that part of the archive |
| `saarland` | Landtag des Saarlandes | **aggregator** | structured | as linked, rewritten | — | the linked `Drucksache/*.pdf` is an HTML page with an iframe; the URL is rewritten to the `Downloadfile.ashx` endpoint the iframe names |
| `sachsen` | Sächsischer Landtag | **aggregator** | structured | question PDF + answer PDF, every position of the Vorgang | — | the link is an EDAS frameset viewer; the real file is read from the viewer's navigation frame, one request per document; viewer links expire, the resolved file does not |
| `niedersachsen` | Niedersächsischer Landtag | **aggregator** | structured | question PDF + the answer paper from a frozen map | — | nothing reachable links question to answer, so `ka-factory answers niedersachsen` sweeps a Drucksachen range once and freezes the map the connector reads |
| `brandenburg` | Landtag Brandenburg | **aggregator** for the list; the documents live on `parlamentsdokumentation.brandenburg.de`, whose robots.txt is `Disallow: /` | text_layer | as the aggregator links them | — | produces **nothing** by default and says why; `--ignore-robots` fetches, at one request per 4 s; the file is read at run time, so a lifted rule takes effect without a release |
| `sachsen-anhalt` | Landtag von Sachsen-Anhalt | **aggregator** for the list; documents on `padoka.landtag.sachsen-anhalt.de`, robots.txt `Disallow: /` | text_layer | as the aggregator links them | — | same shape as Brandenburg |
| `parlamentsspiegel` | all 16 Länder | **aggregator** — the `/suche` HTML search, one result markup for every Land | structured | as linked | — | no API and no document interface by the portal's own statement; metadata and PDF links only; each record is filed under the Land its Herkunft code names |
| `baden-wuerttemberg` | Landtag Baden-Württemberg | aggregator only | structured | as linked | — | the Landtag runs PARLIS, an ESearch portal; no connector for it yet |
| `hamburg` | Hamburgische Bürgerschaft | aggregator only | structured | as linked | — | runs ParlDok, the same software as MV and Thüringen; its service was unreachable when this was built |
| `hessen` | Hessischer Landtag | aggregator only | structured | as linked | — | runs LIS (STARWEB family); the search entry point has not been located |
| `rheinland-pfalz` | Landtag Rheinland-Pfalz | aggregator only | structured | as linked | — | the classic OPAL servlet is retired; the current portal is a client-side ESearch application |
| `schleswig-holstein` | Schleswig-Holsteinischer Landtag | aggregator only | structured | as linked | — | e-LISSH, an ESearch portal like Baden-Württemberg's |

All 17 parliaments are registered. The ones without a connector of their own say so
rather than quietly returning nothing — run `ka sources list`, or
`ka sources show <key>` for one Land's notes. The survey behind this table, with the
robots.txt verdict per host, is in the workspace's `.reviews/` folder.

Coverage is honest, not complete. Across 96 records from eight parliaments, 68
extract completely (measured before the October 2026 rules, which also name an unknown question
date, answer date or asker as a hole) and 89 yield at least one question/answer pair; the rest abstain and land
in `ka review` rather than in the corpus as half-read records. A record's documents
are all read, not just one — a Land that publishes the question and the answer as
separate papers would otherwise yield every answer and no question.

A record is dated by **when the Anfrage was asked**, not when it was answered — so
`--since`/`--until`, `--year` and `--from`/`--to` all mean the question's date. A record
whose question date is unknown (a combined paper carries only its answer's) is in no
`--year`/`--from`/`--to` window, `ka search` says how many were left out, and the hole is
in `abstained_fields`. A sync window, which has to decide what to fetch, places such a
record at its answer date and says so.

### Credentials

Precedence is always **flag > environment variable > none**, and no key is ever
bundled. The Bundestag publishes a public DIP key on
<https://dip.bundestag.de/über-dip/hilfe/api>; personal keys come from
`parlamentsdokumentation@bundestag.de`.

## Tiers, and where a model is allowed

| Tier | Source shape | What runs |
|------|-------------|-----------|
| `structured` | API / XML export | field mapping; highest trust |
| `text_layer` | PDF with a text layer | the PDF reader in `packages/lib-pdf`, then frozen segmentation rules |
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
