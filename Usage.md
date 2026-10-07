# Usage

Every command, with the options that matter. `ka --help` and `ka <command> --help`
are authoritative; this is the narrative version.

## Global options

| Option | Meaning |
|--------|---------|
| `--corpus <dir>` | where the corpus lives (default: `$OPENKA_CORPUS`, else `$XDG_DATA_HOME/openka`, else `~/.local/share/openka`); the flag and the variable are taken as given, spaces included |
| `--blobs <dir>` | keep the archived documents in this existing directory instead of `<corpus>/blobs` (default: `$OPENKA_BLOBS`); while it is missing, `sync`, `open` and `verify` exit 3 and every other command works |
| `--timeout <ms>` | timeout per request attempt; a timed-out request is retried once |
| `--user-agent <ua>` | override the identifying User-Agent; not blank, no control characters, nothing above U+00FF |
| `--max-retries <n>` | retries (0–10) for a transient 429/503 or a dropped connection; a response over `--max-response-bytes` is never retried |
| `--max-response-bytes <n>` | hard cap on one response body (at least 1024) |
| `--min-host-interval <ms>` | minimum delay between two requests to one host (0–60000) |
| `--max-redirects <n>` | redirects to follow (0–10); `0` surfaces a 3xx as an error |
| `--compact` | compact JSON output |
| `--quiet` | suppress progress on stderr (`ka sync`'s progress line) |

## `ka sync`

```bash
ka sync --source berlin --since 2024-01-01 --until 2024-06-30 --limit 200
ka sync --source nordrhein-westfalen --since 2025-03-01 --until 2025-04-30
ka sync --source bund --api-key "$DIP_KEY" --period 21
ka sync --source bund --period 3                        # 1957–1961: from DIP's Drucksachen, question only
ka sync --source parlamentsspiegel --since 2025-01-01   # all 16 Länder, metadata + links
ka sync --source berlin --metadata-only                 # no downloads: new records abstain on qa, stored ones keep their documents
ka sync --source berlin --force                         # re-extract unchanged inputs
ka sync --source berlin --ocr tesseract --ocr-version 5.3.4 --ocr-traineddata /usr/share/tessdata/deu.traineddata
ka sync --source berlin --source bund --since 2026-01-01  # side by side, one corpus lock
ka sync --all --since 2026-09-01                        # every source with its own adapter
ka sync --source bund --wait                            # queue behind a run holding the corpus
ka sync --source berlin --since 2026-01-01 --dry-run    # how many, and how much disk, before committing to it
ka sync --source berlin --min-free 20G                  # keep 20 GB free (default 1 GB; 0 checks none)
ka --corpus /Volumes/STICK/openka sync --source berlin --allow-fs exfat   # a corpus on exFAT, on purpose
```

**Look before you sync.** `--dry-run` runs discovery only — no document is downloaded,
nothing is written, the corpus lock is not taken — and says what a sync over the window
would do:

```
berlin 2026-01-01..: 2,471 Anfragen discovered, 0 already in corpus
documents to fetch: 2,471 (≈ 270 MB at 110 KB avg; HEAD-sampled n=20)
space: ≈ 270 MB to fetch, 85 GB free for /Users/me/.local/share/openka
```

"Documents to fetch" are the document URLs whose bytes the corpus does not hold yet,
each counted once. The size is the average of what the corpus already holds for that
source once it holds at least 20 documents (`ka stats --disk` shows it), and otherwise
the `Content-Length` of a HEAD request to up to 20 of the documents, spread over the
list — asked under the same robots.txt rules and pacing as a sync. Discovery itself is
not free: Berlin's is a 50+ MB feed. With `--json` the plan is an object (an array for
several sources). When the download would not fit beside `--min-free`, or a sync would
refuse the volume, a `warning:` line on stderr says so in place of the `space:` line.

**Where the corpus may live.** Before it writes anything — the lock file is the first
write — `ka sync` checks the volume of the corpus and, when it is named apart, of
`--blobs`, and exits 3 with nothing written when:

- the volume is **FAT32 or exFAT**. Neither has a journal or extended attributes (macOS
  writes a `._` file beside every file), and FAT32 adds a 4 GB file limit and 65,534
  entries per directory. `--allow-fs fat32` / `--allow-fs exfat` (repeatable) accepts
  it anyway. A **network filesystem** (SMB, NFS, AFP, WebDAV) is a warning, not a refusal;
- the volume has less free space than **`--min-free`** (default 1 GB; sizes such as
  `500M`, `20G`, in decimal units; `0` checks none);
- the documents still to fetch would not fit beside that floor. The estimate is the
  average of what the source already archived, once it holds at least 20 documents.
  A sync sends no HEAD requests to guess, so a source's first sync is guarded by the
  floor alone. Its exit is 3 with nothing downloaded.

While it runs, a sync checks the free space before each Anfrage. Below the floor it
stops the way Ctrl-C does: the Anfrage in hand is finished, the catalog saved, and the
run exits 3 with `berlin: stopped after 812 of 2,471 Anfragen — only 900 MB free…`.
Free some space and run the same sync again to continue.

The filesystem comes from `mount` on macOS and from `statfs` on Linux. Elsewhere it is
unknown, and only the free space is checked.

**Several sources at once.** `--source` is repeatable: the sources run side by side in
one process, under one corpus lock, each paced on its own — and a host two of them
reach (the Parlamentsspiegel) is paced once for both, so it sees no more requests than
one sync would send. Sources of the same parliament still run one after the other, and
`parlamentsspiegel` runs after the rest. `--all` takes every source with an adapter of
its own (not the `parlamentsspiegel` aggregator, whose records would overwrite theirs)
and skips one whose credential is missing, with a note; named with `--source`, that is
an error as before. The window and `--limit` apply to each source. The summary is one
block per source; with `--json` an array of reports (`{ "source", "error" }` for a
source that failed). A failing source does not stop the others; the command exits with
the first failure's code once all are done.

**Waiting instead of failing.** With `--wait`, a sync that finds the corpus held by
another run says "Waiting for the corpus…" once, tries again every two seconds and
starts when it is free — Ctrl-C stops the wait (exit 130). Without it, the second run
exits 3 as before.

Idempotent: a second run over an unchanged window costs one conditional request and
stores nothing. `--force` bypasses both the feed's `ETag` and the per-record check.

**Progress goes to stderr while it runs.** After discovery, `berlin: 2471 Anfragen
discovered`, then `berlin: 1220/2471 · 0 failed · 4.1/min · ~5h 05m left`, and a
`! <reference>: <reason>` line for every Anfrage that failed. On a terminal the line is
redrawn in place; written to a file or a pipe it is a plain line every 25 Anfragen or
30 seconds, so a log shows how far the run got. `--json` shapes stdout only and keeps
it; `--quiet` silences it.

**One writer at a time.** `sync`, `reindex` and `review --mark-verified` hold the
corpus's `lock` file while they write; a second writer exits 3 with "The corpus is in
use by another run (…)", where two syncs used to lose index entries and catalog rows
silently. Reading commands do not wait. A lock left by a killed run on the same
machine is taken over; the message names the file to delete otherwise.

**Interrupting a sync is safe.** Ctrl-C (or SIGTERM) finishes the Anfrage in hand,
saves the catalog and exits 130 (143); a second signal stops at once. The catalog is
also saved every 25 Anfragen, so even a `kill -9` loses at most that many catalog rows
— and running the same sync again puts them back: a stored record that is unchanged
but missing from the catalog is indexed again and reported ("… were on disk but
missing from the catalog"). `ka stats` and `ka verify` name record files the catalog
lacks.

**A corpus synced before this release** may hold records that an interrupted run left
out of the catalog for good: they open with `ka get`, but search, stats, export and
feed do not see them, and re-runs called them "unchanged". `ka stats` now lists them;
`ka reindex` (or a re-sync of the same window) brings them back.

**Dates mean when the Anfrage was asked.** `--since`/`--until` here, and `--year`
and `--from`/`--to` on `search` and `export`, all filter on the question's date, not
the answer's — a question asked in June is often answered in August, and the other
reading makes a window exclude exactly what it was meant to include. An `--until`
before `--since` is a usage error (exit 2), not an empty sync.

Where the question's date is unknown — a combined paper (Schleswig-Holstein,
Mecklenburg-Vorpommern, Baden-Württemberg, Bayern's portal rows) prints only the
answer's — `search`/`export`/`feed` leave the record out of every `--year`/`--from`/
`--to` window and say on stderr how many they left out; it used to be placed at its
answer's date, so a February question showed up in May. A sync window cannot leave
those refs out without fetching nothing from such a Land, so it places them at the
answer date and warns: widen `--until` to catch a question answered after it. Bayern's
papers name the question's date in their head ("vom …"), and the extractor reads it.

## `ka search`

```bash
ka search "brücken zustand"              # all terms must match
ka search '"marode brücke"'              # an exact phrase
ka search "brücke -sanierung"            # exclude a term
ka search --parliament berlin --year 2024 --party SPD
ka search --needs-review --parliament bund
ka search --like berlin-19-10006         # needs `ka-factory embed` first
ka search "radwege" --snippet --json
```

Filters are repeatable (`--parliament berlin --parliament bund`). An empty query
lists everything that passes the filters. `--party` matches the party, not the
spelling: the sources print the Greens as "Grüne", "GRU" or "BÜNDNIS 90/DIE GRÜNEN", the
Left as "Die Linke" or "DIE LINKE", the FDP as "Freie Demokraten" — any of them (or
"GRÜNE", "Linke", "FDP") finds all; records keep the spelling their source printed. With `--like`, `total` in the JSON counts
every similar record, not just the page `--limit` shows, as it does for keyword search.

## `ka get` / `ka show` / `ka open`

```bash
ka get berlin-19-10006 --format json     # canonical JSON — the stored bytes
ka get berlin-19-10006 --format jsonld   # schema.org + an openka: namespace
ka get berlin-19-10006 --format csv
ka get berlin-19-10006 --format md -o anfrage.md
ka show berlin-19-10006                  # rendered for reading
open "$(ka open berlin-19-10006)"        # the archived PDF
```

`ka open` prints a path rather than launching a program, and only after checking the
bytes there. `--role` is one of `question_pdf`, `answer_pdf`, `combined_pdf`,
`metadata`; another value is a usage error (exit 2). Archived bytes that are missing
or no longer hash to their name are a corpus problem (exit 3).

## `ka verify`

```bash
ka verify berlin-19-10006        # one record
ka verify --limit 100            # a sample
ka verify --all --json           # everything, machine-readable
```

Re-runs the extraction from the archived bytes and asserts the canonical output is
byte-identical. Exits non-zero if any record does not reproduce.

What that covers: everything the extractor derives from the archived documents — the
full text, the Q/A pairs, the markers, the documents' digests and the extraction
stamp. The metadata a source supplied when the record was discovered (title, askers
and parties, `answered_by`, `dates`, the documents' URLs) is not archived; re-extraction
takes it from the record itself, so an edit to it still reproduces. `verify` says so
on stderr, and `--json` lists those fields as `unchecked`. For them, the archived PDF
(`ka open`) is the check. A record that cannot
be read — a corrupt record file, or archived bytes that are missing or no longer hash
to their name — is reported as a `FAIL` and the rest are still checked; the exit code
is then 3, the corpus-problem code, as `ka open` gives for the same missing file. The JSON report counts those rows as `unreadable`, and
marks each with `"unreadable": true`.

## `ka review`

```bash
ka review                                     # the abstention queue, worst first
ka review --source berlin --limit 50
ka review --mark-verified berlin-19-10041     # a person checked it against the PDF
ka review --group-by field                    # the queue per source, by kind of field
```

**Group the queue to find the rule that fails.** A queue of 421 records reads as 421
problems; `--group-by field` shows it per source by the kind of field abstained on —
`qa[3].answer` counts as `qa[].answer` — with how often, in how many records, and the
first example ids:

```
berlin: 421 record(s) in the queue
  FIELD                  OCCURRENCES  RECORDS  EXAMPLES
  qa[].question                1,008      400  berlin-19-20001, berlin-19-20005, …
  qa[].answer                    959      398  …
```

The same breakdown is in `ka stats --json` (`abstained_by_field` per parliament, over all
records with holes, verified or not), and `ka-factory drift` reports a field whose rate
rose (`field_spike`), which the overall abstention rate can hide. It is read from the
catalog; rows catalogued by an older version lack it and are counted as
`abstained_fields_unknown` until `ka reindex`. The records do not keep which
segmentation rule refused a field, so there is no grouping by rule.

Marking a record verified does **not** fill its holes; it records that someone
looked. The mark survives `ka sync --force` when re-extraction yields the same record
(same bytes, same extractor); when the record changes, the mark is dropped and the sync
warns, since what was checked is no longer what is stored. `ka verify` knows this and does not treat it as a mismatch. A verified record
leaves the queue, but `ka search --needs-review` still finds it: that filter selects
records with abstained fields, verified or not.

## `ka export` / `ka feed`

```bash
ka export --format csv --out corpus.csv
ka export --format jsonl --parliament berlin --year 2024
ka feed --party GRÜNE --limit 50 --out gruene.atom
ka feed --query "brücken" --title "Brücken-Anfragen"
```

Formats: `csv` (one row per record, `abstained_fields` as a column), `jsonl` (JSON
Lines — one compact canonical record per line, keys sorted) and `jsonld` (one JSON-LD
document: an array of the schema.org nodes `ka get --format jsonld` prints).

`export` writes every match — by id, or the most relevant first with `--query` — and
`feed` picks its `--limit` newest entries from the whole selection. A catalog row whose
record file is gone is named on stderr and left out; `ka reindex` rebuilds the catalog.
`ka search` lists such a row (the catalog still has it) and names it on stderr, and `ka
stats` and `ka verify` name every one (`missing_files` in `ka stats --json`).
A `--query` with nothing searchable in it (`"???"`, `"a"`) is a usage error here as in
`ka search`, rather than a selection of every record.

`-o, --out <file>` (on `get`, `export` and `feed`) writes to a file; `-o -` is stdout.
An existing file is not replaced unless `--force` is given.

## `ka doctor`

```bash
ka doctor                     # filesystem, free space, lock, catalog against records, ._* files
ka doctor --fix               # …and remove the macOS ._* and .DS_Store files
ka doctor --json
ka --corpus /Volumes/STICK/openka doctor --allow-fs exfat --min-free 5G
```

```
corpus        /Users/me/.local/share/openka
  filesystem  apfs (local)
  free        85 GB of 494 GB
blobs         in the corpus
lock          free
catalog       2,471 record(s), all catalogued
platform      no macOS ._* / .DS_Store files
No problems found.
```

The doctor checks what a sync with the same `--allow-fs` and `--min-free` would check,
and also: who holds the corpus lock (a `stale` one, left by a run on this host that is
gone, is taken over by the next writer); whether the catalog and the record files agree
(`ka reindex` repairs that); whether a `--blobs` drive is reachable; and how many macOS
`._*` and `.DS_Store` files lie anywhere in the corpus. Problems go to stderr as
`problem:` lines and exit 3; warnings (a network filesystem, platform files, a stale
lock) do not change the exit code. A corpus that does not exist yet is checked for its
volume only, and nothing is created. `--fix` takes the corpus lock, so it exits 3 while
a sync is writing, and removes only `._*` and `.DS_Store` files — names the corpus never
writes.

## `ka sources` / `ka stats` / `ka schema` / `ka reindex`

```bash
ka sources list            # every parliament, its adapter status, its last sync
ka sources show berlin     # what is specific about one source
ka sources count           # how many Anfragen each upstream holds, beside the corpus
ka sources count --source bund --period 21
ka stats                   # how much of the corpus is parse-complete
ka stats --disk            # …and what blobs, records and index take on disk, per source
ka schema                  # the JSON Schema of a record
ka reindex                 # rebuild the index from the stored records
```

`ka sources count` answers "how complete is my corpus?" with one request per source and no
download: the Bundestag's from DIP (`numFound` of its Kleine-Anfrage Vorgänge, which start
with the 8th Wahlperiode; needs the DIP key), every Land's from the Parlamentsspiegel's
result count — also Berlin's, whose own feed is a 50+ MB download per Wahlperiode. The
BASIS column says which. `--period` narrows DIP's count and the corpus side; the
Parlamentsspiegel cannot count by period, so such a row gets a note (named alone with
`--source`, it is a usage error). The `total` row adds up the parliaments counted.

`ka reindex` rebuilds the catalog and the search index without reading the old ones,
so it repairs a corrupt catalog. The new index is built in memory and written over the
old one shard by shard, so a reindex that is killed part-way leaves a searchable index
behind rather than none; run it again to finish. A record that cannot be read is named on stderr and
left out of the index, and the command exits 3.

## `ka-factory`

```bash
ka-factory lint                                   # no generative model on the line
ka-factory goldens list
ka-factory goldens add berlin-19-10041 --note "sub-items and a date at line start"
ka-factory goldens verify                         # the regression gate
ka-factory health --save-baseline                 # into the corpus: health-baseline.json
ka-factory drift                                  # classified, with a repair suggestion
ka-factory answers niedersachsen --period 19 --from 7900 --to 8115 --merge
ka-factory embed                                  # frozen vectors for `ka search --like`
ka-factory embed --from vectors.jsonl --model bge-m3 --model-sha256 <hex>
```

`goldens add` without `--dir` files the golden in its source's connector package
(`packages/connector-<source>/fixtures/`), the layout `goldens list` and
`goldens verify` read; the source is the record's parliament unless `--source` says
otherwise.

Goldens are fixtures of the repository's packages and are not part of the npm package:
run the `goldens` commands inside a checkout, or name a fixture directory with `--dir`.
Both `goldens list` and `goldens verify` exit 1 when the set they read is empty.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | success (including `--help` and `--version`) |
| 1 | an error: an upstream failure, a failed verification, a missing record |
| 2 | a usage error (a rejected option value, a malformed record id, an unknown command) |
| 3 | a corpus problem: missing or unreadable (a `--corpus` that does not exist included), held by another run, on a refused filesystem or short of free space (`ka sync`), or anything `ka doctor` calls a problem |
| 4 | the upstream returned 404 |
| 130 / 143 | `ka sync` stopped early on Ctrl-C / SIGTERM, after saving its catalog |
