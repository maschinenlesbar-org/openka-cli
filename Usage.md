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
| `--max-response-bytes <n>` | hard cap on one response body (at least 1024; default 134217728, 128 MiB). A body that declares more is not downloaded. A document over it is left out of its record — the record is stored with holes, in `ka review` — and the sync warns with the value to pass to fetch it; `ka sync --dry-run` names sampled documents over it |
| `--min-host-interval <ms>` | minimum delay between two requests to one host (0–60000; default 500). A source with a floor of its own — Brandenburg and Sachsen-Anhalt, 4000 ms, see `ka sources show <key>` — is never made faster by it: a lower value is kept out, and `ka sync` says so |
| `--max-redirects <n>` | redirects to follow (0–10); `0` surfaces a 3xx as an error |
| `--compact` | compact JSON output |
| `--quiet` | suppress progress on stderr (`ka sync`'s progress line) |
| `--log-format <format>` | how errors, warnings, notes and progress are written to stderr: `text` (default; log4j style, `2026-10-09T14:03:12.481Z WARN  [ka.sync] …`) or `jsonl` (one JSON object per line, starting with `ts`, `level`, `topic`, `msg`). Before or after the command (`ka sync --log-format jsonl` works). stdout is not affected |

### The log on stderr

stdout carries the data; everything else a command says goes to stderr as a **log
record**: a timestamp (UTC, milliseconds), a level (`ERROR`, `WARN`, `INFO`) and a topic,
the program and the area the record comes from. The default text form:

```text
2026-10-09T14:03:12.481Z INFO  [ka.http] sachsen-anhalt: at most one request per 4 s per host — …
2026-10-09T14:03:13.020Z WARN  [ka.store] the corpus /Volumes/stick/openka is on a network filesystem (smbfs) …
2026-10-09T14:03:14.902Z ERROR [ka.cli] unknown option '--sorce'
```

`--log-format jsonl` writes the same records one JSON object per line —
`{"ts":"…","level":"ERROR","topic":"ka.cli","msg":"unknown option '--sorce'"}` — and
`ka sync`'s events add their fields after `msg` (below). The areas of `ka`: `cli` (usage
errors, commander's messages, unexpected errors), `http` (an upstream's error answer or
a dropped connection, a source's request floor), `store` (the corpus: missing, locked,
the volume it is on, catalog gaps, macOS files), `sync` (progress off a terminal, the
events, warnings and errors of a run), and every other command under its own name —
`search`, `export`, `review`, `verify`, `reextract`, `rm`, `status`, `sources`, `stats`,
`config`, `doctor`, `open`, `get`, `feed`. An error that ends a run is logged as an
`ERROR` record: under `cli` for a usage error, `store` for a corpus problem, `http` for
an upstream's, and otherwise under the command. `ka-factory` writes the same records under
its own name: `ka-factory.cli`, `ka-factory.goldens`, `ka-factory.health`,
`ka-factory.drift`, `ka-factory.lint`, `ka-factory.answers`, `ka-factory.embed`.

Left as they are: the progress line `ka sync` redraws in place on a terminal (it is
redrawn, not added to), the prompt of `ka config set`, and `--help`/`--version`, which
go to stdout.

## `ka sync`

```bash
ka sync --source berlin --since 2024-01-01 --until 2024-06-30 --limit 200
ka sync --source nordrhein-westfalen --since 2025-03-01 --until 2025-04-30
ka sync --source bund --period 21                       # the DIP key from `ka config set bund.api-key`
ka sync --source bund --period 3                        # 1957–1961: from DIP's Drucksachen, question only
ka sync --source parlamentsspiegel --since 2025-01-01   # all 16 Länder, metadata + links
ka sync --source berlin --metadata-only                 # no downloads: new records abstain on qa, stored ones keep their documents
ka sync --source berlin --force                         # re-extract unchanged inputs
ka sync --source berlin --ocr tesseract --ocr-version 5.3.4 --ocr-traineddata /usr/share/tessdata/deu.traineddata
ka sync --source berlin --source bund --since 2026-01-01  # side by side, one corpus lock
ka sync --all --since 2026-09-01                        # every source with its own adapter
ka sync --source berlin@2025-01-01..2025-12-31 --source bund@2026-01-01..2026-12-31   # a window per source
ka sync --source bund@period=21 --source bund@period=20  # one source, two windows, one after the other
ka sync --plan jobs.toml --wait                         # a queue of jobs from a plan file
ka sync --source bund --wait                            # queue behind a run holding the corpus
ka sync --source berlin --since 2026-01-01 --dry-run    # how many, and how much disk, before committing to it
ka sync --source sachsen-anhalt --since 2023-01-01 --until 2023-12-31 --ref 08/2391 --ref 08/2390   # only these two
ka sync --source sachsen-anhalt --since 2023-01-01 --retry-failed   # only what failed last time
ka sync --source sachsen-anhalt --since 2023-01-01 --only-new       # only what the corpus lacks
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
source once it holds at least 20 documents (`ka stats` shows it), and otherwise
the `Content-Length` of a HEAD request to up to 20 of the documents, spread over the
list — asked under the same robots.txt rules and pacing as a sync. Discovery itself is
not free: Berlin's is a 50+ MB feed. With `--json` the plan is an object (an array for
several sources). When the download would not fit beside `--min-free`, or a sync would
refuse the volume, a `WARN` record of `ka.store` on stderr says so in place of the `space:` line.

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

**A window per source.** A `--source` may carry a window of its own after `@`:
`berlin@2025-01-01..2025-12-31` (either side of `..` may be empty), `bund@period=21`,
`bund@2026-01-01..,limit=50`; `since=`, `until=`, `period=` and `limit=` may also be
written out, separated by commas. What a source leaves out, the shared `--since`,
`--until`, `--period` and `--limit` fill in, field by field. One source may be named
several times with different windows (`bund@period=21 --source bund@period=20`): its
jobs share the source's lane and run one after the other, in the order given. Output,
progress and `--json` (a `job` field on each entry) name every job by what was typed —
`bund@period=21`, or just `berlin` for a source without a window of its own. A job's
selection is part of its name (`berlin@only-new`), so a plan does not take it for the
full job.

**Only some Anfragen of a window.** A sync re-checks every Anfrage it discovers, and a
stored one costs a request; at Sachsen-Anhalt's 4 s floor that is about 15 a minute, so
hours to reach the few that matter. Three flags choose what a sync handles. Discovery
still runs over the window, and an Anfrage left out costs nothing:

- `--ref <reference>` (repeatable): only these, or ones they were filed under before
  (an unanswered Sachsen-Anhalt question named `08/4011` finds `KA 8/4011`). A
  reference the window does not hold is a warning naming it.
- `--retry-failed`: only the Anfragen whose last attempt failed. A sync records each
  failure per source, and a later run that stores the Anfrage, or finds it unchanged,
  clears it. A failure outside the window is named in a warning. With 0.7.0 or earlier,
  nothing was recorded, so name those with `--ref`.
- `--only-new`: skip every Anfrage the corpus holds with all its documents, and take the
  rest: those not in the corpus, and those stored without a document (a glued link, a
  document over the size cap, a timeout).

`--ref` and `--retry-failed` together take either; `--only-new` then narrows what they
took. `--limit` counts what discovery returns, before the selection. Such a run discovers
the whole window and leaves the feed's own validators as they were, since it did not
handle the whole window. The report says `N not selected`, `--json` has `skipped`,
`--dry-run` adds `N selected`. In a `--source` window they are `ref=08/2391` (repeatable),
`retry-failed` and `only-new`: `sachsen-anhalt@2023-01-01..2023-12-31,ref=08/2391`.

**A plan file.** `--plan jobs.toml` runs a queue of jobs from a file:

```toml
[defaults]                       # optional; what every job does not set itself
continue_on_error = true         # false: start no job after one has failed

[[job]]
source = "berlin"
since  = "2025-01-01"
until  = "2025-12-31"

[[job]]
source = "bund"
period = [21, 20, 19, 18]        # one job per period, in this order
log    = "logs/sync-bund-wp{period}.log"
```

A `[[job]]` takes `source` (required), `since`, `until`, `period` (a number, or a list
for one job per period), `limit`, `ref` (a reference, or a list), `retry_failed`,
`only_new` and `log`; `[defaults]` takes the same but `source` and `ref`, plus
`continue_on_error`. A job's `only_new = false` overrides a default's `true`. The file is the part of TOML these need: strings, integers,
`true`/`false`, dates (quoted or not), lists and comments. Anything else, or an unknown
key, is refused with the file and line, and nothing of the plan runs. The jobs run like
several `--source`s: different parliaments side by side, one parliament's jobs one
after the other, all in one process under one corpus lock (`--wait` queues the whole
plan behind another run). The command line's window flags do not go with `--plan`;
`--metadata-only`, `--force`, `--ignore-robots`, `--api-key`, the OCR, volume and
output flags apply to every job.

A job's `log` (a path relative to the plan file; `{source}`, `{period}`, `{since}`,
`{until}` and `{limit}` are filled in) is appended to with one text log record per
event, whatever `--log-format` is — `2026-10-09T14:03:12.481Z INFO  [ka.sync] bund@period=21:
2471 Anfragen discovered`, the job's name leading the message: `started`, the Anfragen
discovered, every Anfrage stored, unchanged or failed (a `WARN`), every warning (`WARN`)
and error (`ERROR`) in full, and how the job ended. The run ends with a summary of the
plan, one row per job:

```
JOB                            STATUS       DISCOVERED    STORED UNCHANGED    FAILED
berlin@2025-01-01..2025-12-31  done             12,904    12,880        24         0
bund@period=21                 done earlier          —         —         —         —
bund@period=20                 failed                —         —         —         —
```

**A plan picks up where it stopped.** The corpus keeps which of the plan's jobs are done
in its current round (under `state/queues/`, keyed by the plan file's path). A job is
done when it covered its window — not when it failed, was interrupted, or stopped low on
space; per-Anfrage errors in a job that ran through do not hold it back. A rerun of the
plan skips the done jobs, with a note, so a queue stopped by Ctrl-C, a reboot or a full
disk continues with the job it stopped in. Once every job is done the round closes, and
the next run of the plan runs them all again — which is how a plan run from cron stays
current. `--restart` discards an unfinished round and runs every job. `--dry-run` sizes
the jobs a run would start, and adds a `total:` line over them.

**Waiting instead of failing.** With `--wait`, a sync that finds the corpus held by
another run says "Waiting for the corpus…" once, tries again every two seconds and
starts when it is free — Ctrl-C stops the wait (exit 130). Without it, the second run
exits 3 as before.

Idempotent: a second run over the same window, with the upstream unchanged, costs one
conditional request and stores nothing ("upstream reports no change since the last
complete sync of this window"). A different window is looked at in full even when the
feed has not changed, and a run that stopped early (Ctrl-C, low disk space) does not
keep the feed's new validator, so running it again continues. `--force` bypasses both
the feed's `ETag` and the per-record check.

**Progress goes to stderr while it runs.** After discovery, `berlin: 2471 Anfragen
discovered`, then `berlin: 1220/2471 · 0 failed · 4.1/min · ~5h 05m left`, and a `WARN`
record `berlin: <reference> failed: <reason>` for every Anfrage that failed. On a terminal
the line is redrawn in place (a failed Anfrage is printed above it, and the line drawn
again below); written to a file, a pipe or cron's mail it is an `INFO` record of
`ka.sync` every 25 Anfragen or 30 seconds, so a log shows how far the run got:

```text
2026-10-09T14:03:12.481Z INFO  [ka.sync] berlin: 2471 Anfragen discovered
2026-10-09T14:05:40.102Z WARN  [ka.sync] berlin: 19/24990 failed: HTTP 503 …
2026-10-09T14:06:02.917Z INFO  [ka.sync] berlin: 25/2471 · 1 failed · 8.8/min · ~4h 38m left
```

`--json` shapes stdout only and keeps it; `--quiet` silences it.

**An event log in JSON Lines.** With `--log-format jsonl` (the program's option, before or
after `sync`) every event is a log record of `ka.sync` on stderr, in place of the progress
line; `--log-file <path>` appends the same records to a file whatever `--log-format` is,
and keeps the progress line on stderr. A record starts with `ts`, `level`, `topic` and
`msg`, a sentence for people; then `event`, and for a job's events `job` and `source`, so
the events of several sources share one stream:

```jsonl
{"ts":"2026-10-06T18:00:01.020Z","level":"INFO","topic":"ka.sync","msg":"berlin: started","event":"start","job":"berlin","source":"berlin"}
{"ts":"2026-10-06T18:00:01.912Z","level":"INFO","topic":"ka.sync","msg":"berlin: 2471 Anfragen discovered","event":"discovered","job":"berlin","source":"berlin","count":2471}
{"ts":"2026-10-06T18:00:03.310Z","level":"INFO","topic":"ka.sync","msg":"berlin-19-24986 stored","event":"record","job":"berlin","source":"berlin","id":"berlin-19-24986","status":"stored","index":1,"total":2471,"ms":812,"bytes":141233,"abstained":["qa"]}
{"ts":"2026-10-06T18:00:04.007Z","level":"INFO","topic":"ka.sync","msg":"berlin-19-24987 stored","event":"record","job":"berlin","source":"berlin","id":"berlin-19-24987","status":"stored","index":2,"total":2471,"ms":4100,"bytes":0,"gaps":[{"url":"https://…","gap":"404","reason":"now answers 404"}]}
{"ts":"2026-10-06T18:00:05.250Z","level":"WARN","topic":"ka.sync","msg":"19/24990 failed: HTTP 503 …","event":"record","job":"berlin","source":"berlin","id":"19/24990","status":"failed","index":3,"total":2471,"ms":2050,"error":"HTTP 503 …"}
{"ts":"2026-10-06T18:41:12.401Z","level":"WARN","topic":"ka.sync","msg":"berlin: …","event":"warning","job":"berlin","source":"berlin","message":"…"}
{"ts":"2026-10-06T18:41:12.402Z","level":"INFO","topic":"ka.sync","msg":"berlin: done — 2470 stored, 0 unchanged, 1 failed","event":"done","job":"berlin","source":"berlin","discovered":2471,"stored":2470,"failed":1,…,"timing":{…}}
{"ts":"2026-10-06T18:41:12.403Z","level":"INFO","topic":"ka.sync","msg":"report of 1 job(s)","event":"report","reports":[…]}
```

A `record`'s `status` is `stored`, `unchanged` or `failed`; `abstained` names the fields a
stored record abstains on, `gaps` the documents that were not fetched with their URL and
why (`404`, `robots`, `not-pdf`, `glued`, `too-large`), and `error` why one failed. A job
ends with `done` (the report's counts and `timing`; its warnings come just before as
`warning` events), `failed` (an `ERROR`) or `skipped` (a `WARN` when an earlier job
failed, an `INFO` when the run was interrupted); the run with `report`, which is what
`--json` prints. The levels: `INFO` for `start`, `discovered`, a stored or unchanged
`record`, `done` and `report`; `WARN` for `warning` and a failed `record`; `ERROR` for a
failed job. Every other diagnostic of the run — a source's request floor, a volume
warning, the error a failed run ends with — is a record of its own area (`ka.http`,
`ka.store`, `ka.cli`, …) without an `event`, in the same stream and in the `--log-file`
too, so both are JSON throughout. Until 2026-10-09 the events had no `level`, `topic` or `msg`,
their `ts` had no milliseconds, and the other lines were wrapped into `note` events.
`--json` and the summary on stdout are unchanged.

**The pace is the recent one, and the line says where the time goes.** The rate and
the time left are taken over the last ten minutes, so a run whose upstream slows down
says so within minutes rather than hours; once the recent pace parts from the average
by more than 15%, both are shown:

```
berlin: 1514/2471 · 0 failed · 17/min now (34/min avg) · ~56 min left · upstream 3.4 s/req · waiting 12% · extract 0.1 s
```

`upstream … s/req` is the average time a request takes; `waiting` the share of the run
spent waiting before requests — the host's interval (`--min-host-interval`, a source's
own floor) and the backoff after a 429/503; `extract` the time per Anfrage spent
extracting; `index` the share spent writing the index; then `retries N (… throttled, … timeout, … connection, … other)`,
`reconnected N` and `throttled N×` (429/503 answers) when there were any. A slow
upstream reads as a high `upstream`; one asking us to slow down as `throttled`; a polite
floor as a high `waiting`. `reconnected` counts requests sent again at once on a new
connection, because the server had closed the kept-alive one. They are not retries,
since the first never reached the server, and they cost no wait. The report has the same
as `timing`, in `--json` too: `elapsedMs`, `requests`, `retries`, `retryReasons`,
`reconnects`, `throttled`, `upstreamMsAvg`, `upstreamMsP95`, `waitMs`, `extractMs`,
`storeMs`, `indexMs` (and, as before, `bytesFetched`). `index N%` is the share of the run
spent writing the search index and the catalog. A sync writes them every two minutes,
each index file once for everything stored since. Until 2026-10-09 every stored record
rewrote nearly the whole index, about ten seconds a record on a USB stick in a corpus
of 7,500, and more as the corpus grew (issue #30).

Until 2026-10-09 a request could go out on a connection the server had already closed
(Apache closes an idle one after 5 s), because the sync was busy storing a record when the
close arrived. It failed with ECONNRESET and was retried after a backoff and the host's
floor: 615 retries in 1,481 requests to Sachsen-Anhalt's document server, none of them the
server's doing (issue #31). The transport now lets the event loop take a turn before it
picks a connection, and sends a GET or HEAD that still fails that way again on a new one.

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

The content is always compared, also for a record an older build stamped. After an
upgrade every record carries the old `extraction.extractor_version`, and `verify` tells
the two cases apart:

```
VERSION berlin-19-25613: produced by pkg:0.2.0+extract:6f021d93d3c3, content identical under pkg:0.6.0+extract:0992e8afa678
DIFF berlin-19-25614: content differs at qa[3].answer (produced by pkg:0.2.0+…, this build is pkg:0.6.0+…)
23/25 record(s) reproduced byte-identically. 1 more reproduce in content but carry another extractor version — `ka reextract` restamps them. 1 differ in content.
```

A record whose content differs under the *same* version is a `FAIL`, as before: that is
the verdict the version stamp exists to rule out. The exit code is the worst of what was
found: 3 when something could not be read, 1 when content differs or could not be
checked, 5 when every content reproduces but some records carry another build's version
— the corpus is fine, `ka reextract` restamps it. In `--json` each result has a
`verdict` (`reproduced`, `version-only`, `differs`, `unreadable`, `unchecked`) and
`contentDifferences` (the differences without the version stamp); the report counts
`versionOnly` and `differs`. Checking a record with the logic of the build that stored it
(`--against-stored-version`) is not possible: older extractors are not bundled.

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

## `ka reextract`

```bash
ka reextract --all --dry-run                # what an upgrade changes, writing nothing
ka reextract --all                          # every record an older build stamped
ka reextract --parliament berlin --year 2025
ka reextract berlin-19-25613
ka reextract --all --force                  # also the records this build stamped already
```

Brings stored records up to this build's extractor from their archived bytes — the
same re-extraction `verify` runs, with the record's own metadata — without discovery
and without a request. Records already stamped by this build are left alone unless
`--force`. Records are named by id, or selected with `--all` or the filters `ka export`
takes (`--parliament`, `--party`, `--year`, `--period`, `--from`, `--to`); ids and a
selection together are refused, and so is neither.

Each record ends up as one of: only restamped (content identical), `CHANGED` with the
field paths that move — plus what it newly completes (abstentions the new extractor
fills) and what it newly abstains on — identical (with `--force`), already current, or
skipped (unreadable, or an OCR record without `--ocr`). A `human_verified` mark stays
where the content did not move and is dropped, with a note, where it did. What moved is
written under the corpus lock, and the index and catalog are then rebuilt as `ka
reindex` does. `--dry-run` reports the same and writes nothing; `--json` prints the
report (`counts` per outcome, `results` per record). Exit 3 when a record could not be
read (the rest are still done), 1 when an OCR record was left out.

**Q/A are compared by question number.** A new reading that finds one more pair shifts
every `qa[n]` after it, so `newly abstained` can name a field that only moved. For a
record whose Q/A changed, `CHANGED` therefore also prints `Q/A: 37 → 45 pairs, 24 → 31
questions, 27 → 27 answers`, plus what is read now and what is no longer read, by number
(`17.question`, `9b.answer`, `16a` for a whole pair). The run ends by naming the records
that read fewer answers or questions than before; those are the ones to check against
their PDF. `--json` has the same under `results[].qa` (`before`, `after`, `gained`, `lost`).

**A record an earlier build filed under another paper's id moves.** Up to 0.6.0, an
unanswered Sachsen-Anhalt question was stored as Drucksache `08/1487`, where Drucksache
8/1487 belongs (issue #25). `ka reextract` gives such a record the reference and id this
build gives it (`KA 8/1487`, `sachsen-anhalt-8-ka-1487`), whatever its stamp, and prints
`MOVED old → new`. Where the new id is taken already, the old record is a stale copy and
is removed (`REMOVED`, outcome `duplicate`). A `human_verified` mark survives a move.
`--dry-run` shows the moves first.

## `ka rm`

```bash
ka rm sachsen-anhalt-8-4011 sachsen-anhalt-8-4012 --dry-run   # what would go
ka rm sachsen-anhalt-8-4011 sachsen-anhalt-8-4012             # the records, their catalog rows and postings
ka rm --parliament sachsen-anhalt --year 2026 --documents     # …and the documents only they referred to
ka rm sachsen-anhalt-8-4011 --move-to ~/openka-removed        # move the files out instead of deleting them
ka rm --orphaned-documents --dry-run                          # documents no record refers to
```

Removes records the way `ka` stored them: under the corpus lock, with their catalog rows
and index postings, so a search never lists a record that is gone. It prints each removed
id on stdout. Records are named by id, or selected with the filters `ka reextract` takes.
Ids and filters together are refused, and so is neither; there is no `--all`. An id
that is not in the corpus refuses the whole removal, and nothing is removed. A record a
person marked `human_verified` is removed with a warning that names it. From 50 records
on, and for a record that cannot be read, the index is rebuilt once instead of record by
record.

The archived documents stay by default: one can belong to several records (Berlin files
question and answer in one PDF), and a document is the one thing a corpus cannot always
fetch again. `--documents` also removes those of the removed records that no remaining
record refers to, and reports how many it kept. `--orphaned-documents` removes every
document no record refers to, such as those left by records removed by hand, and no
record. With `--blobs <dir>` the documents may be shared with another corpus whose
records `ka` cannot see, so `ka rm` refuses to delete them there and only moves them.

`--move-to <dir>` moves the files instead (`<dir>/records/`, `<dir>/blobs/`). The
directory may not lie inside the corpus, and a different file already there is never
overwritten. To undo, move the files back and run `ka reindex`. `--dry-run` reports
and changes nothing; `--json` prints the report (`removed`, `human_verified`,
`blobs_removed`, `blob_bytes`, `blobs_shared`, `moved_to`, `unreadable`).

## `ka review`

```bash
ka review                                     # the abstention queue, worst first
ka review --parliament berlin --limit 50      # --source is the same, as it always was
ka review --include-known-gaps                # also the holes a parliament never fills
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

**Holes no extractor could fill are counted apart.** Some fields a parliament never
publishes: Sachsen-Anhalt prints question and answer as one Drucksache dated by the
answer, and neither the Parlamentsspiegel row nor (but for about 1.5%) the paper names
the question's date. A question synced while it was still unanswered keeps its date: its
answer takes it over when it arrives. Such a field is declared once per parliament (`ka sources show
sachsen-anhalt`, "never has:"). A record whose *only* holes are such fields stays in
`abstained_fields` — it does not pretend to know — but is left out of the review queue,
with a note saying how many and why; `--include-known-gaps` lists them too, and `--group-by
field` marks the field "(never provided by the parliament)". `ka stats` counts them
apart: "855 with abstained fields (830 only where the parliament never provides the
field)". A record that also misses a question or an answer stays in the queue — those
are what the queue is for. Two dates in a Sachsen-Anhalt Fundstelle ("03.12.2025,
10.12.2025 … (Nachtrag 10.12.2025)") are the paper's and its Nachtrag's, not the
question's, and are not read as one.

**Sachsen-Anhalt's unanswered questions are `KA 8/NNNN`.** That Land numbers a Kleine
Anfrage apart from its Drucksachen, and the two numbers overlap. A question still waiting
for its answer is stored as `KA 8/4011` and opens with `ka get sachsen-anhalt-8-ka-4011`.
When the answer arrives as a Drucksache citing it, the question-only record is removed
and the answer carries the question's date. Up to 0.6.0 such a question was filed as
Drucksache `8/4011`, under the id of a different paper, and it could replace an older
answer of that number. To repair a corpus synced with 0.6.0 or earlier, run `ka reextract
--all` first: it moves each such record to its KA id, and removes it where the KA id is
taken already. `ka doctor` names the ones left, and a sync refuses to overwrite one.
Then re-sync the windows of the answers they replaced, which brings the answers back.

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

## `ka status`

```bash
ka status                         # is a sync running, how far is it, did it hang?
ka status --watch                 # look again every 5 s until it is done
ka status --json                  # for a scheduler or a dashboard
ka status --stalled-after 10m     # exit 1 when nothing has moved for 10 minutes
```

```
sync --source berlin --since 2025-01-01   pid 86978 on mb.local   running 2h 03m
  berlin: 1,187/3,476 · 0 failed · 7.1/min (last 10 min) · last progress 12s ago · ~5h 22m left
  bund@period=21: waiting
```

A running `ka sync` keeps `<corpus>/run/status.json` up to date: every job's state
(waiting, discovering, running, done, failed, …), how many Anfragen it has handled of
how many, and samples of its progress over the last ten minutes. The file is replaced
atomically, at most every two seconds while Anfragen go by and at once when a job
starts, finishes discovery or ends. `ka status` reads it together with the corpus lock:

- **running** — the job lines above. The rate is taken over the last ten minutes, not
  since the start, and the time left follows from it.
- **idle** — no lock; the last run, how it ended (`finished`, `interrupted`, `failed`, or
  `stopped` when a volume ran low on space) and each job's counts.
- **stale lock** — the lock names a process on this machine that is gone (a sync killed
  with `kill -9`, a reboot). The last status is shown; the next writer takes the lock
  over.
- **busy** — another writer holds the corpus (`ka reindex`, `ka doctor --fix`), which keeps
  no progress.

A run on another machine (a corpus on a network share) cannot be checked for its
process; a note says so. `--stalled-after <duration>` (`90s`, `10m`, `2h`, `1h30m`) makes
it a check: exit 1 when a running sync has not moved for that long — counted from its
last progress, or from the start of a discovery that is still going — or when its
process is gone. An idle corpus is not stalled. `--json` prints the same as an object:
`state`, `holder`, `run` (the status file), `jobs` with `rate_per_min`, `eta_seconds` and
`quiet_seconds`, and `notes`.

## `ka config`

```bash
ka config set bund.api-key            # prompts for the DIP key, without echo
printf %s "$KEY" | ka config set bund.api-key   # or from stdin, for a script
ka config get bund.api-key            # OSOe…Kkhw — masked
ka config get bund.api-key --reveal   # the whole key, for a script that passes it on
ka config list                        # every stored credential, masked, and the file
ka config unset bund.api-key
```

Credentials live apart from the corpus, in `$XDG_CONFIG_HOME/openka/credentials` (else
`~/.config/openka/credentials`): one JSON object, mode 0600 in a directory of mode 0700,
replaced atomically. `ka config set` reads the value from a prompt that does not echo
it, or from stdin when that is not a terminal, at most 64 KiB (a longer value is refused
and nothing is stored). It refuses the value as an argument,
which would put it into shell history and `ps`, and it does not repeat it in the error;
nor does any `ka config` command repeat a name it does not know (a key typed in its
place), only the names it does. A credentials file inside the corpus is refused, so neither `ka export` nor a copy of
the corpus can carry it along.

A source that needs a key (`bund`) takes it from `--api-key`, else from its environment
variable (`DIP_API_KEY`), else from this file; the file is only read when the first two
have nothing. One that can be read by others, belongs to another user or is a link is
not used, and a command that needs it exits 3 naming the fix (`chmod 600 …`). Output,
`--json` and logs show a key masked at most. The Bundestag rotates its public key, so
a run that DIP rejects needs a new one stored with `ka config set bund.api-key`. No OS
keychain is used yet: on servers, under cron, systemd and in containers it is usually
locked or missing, and this file is what such a setup would use anyway.

## `ka doctor`

```bash
ka doctor                     # filesystem, free space, lock, catalog against records, ._* files
ka doctor --fix               # …and remove the macOS ._* and .DS_Store files
ka doctor --orphaned-documents  # …and count the documents no record refers to (reads every record)
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
`ERROR` records of `ka.doctor` and exit 3; warnings (a network filesystem, platform files, a stale
lock, orphaned documents) do not change the exit code. `--orphaned-documents` also counts
the archived documents no record refers to; it reads every record, so it is not done by
default, and `ka rm --orphaned-documents` removes them. A record an earlier build filed
under another paper's id (see `ka reextract`) is a problem, named by id. A corpus that does not exist yet is checked for its
volume only, and nothing is created. `--fix` takes the corpus lock, so it exits 3 while
a sync is writing, and removes only `._*` and `.DS_Store` files — names the corpus never
writes.

## `ka sources` / `ka stats` / `ka schema` / `ka reindex`

```bash
ka sources list            # every parliament, its adapter status, its last sync
ka sources show berlin     # what is specific about one source
ka sources count           # how many Anfragen each upstream holds, beside the corpus
ka sources count --source bund --period 21
ka stats                   # completeness, coverage, extractor versions, disk use
ka stats --by party        # records (and needs-review share) per party
ka stats --by ministry     # or month, year, period, parliament
ka stats --by party --by year                        # a cross-tab
ka stats --parliament berlin --year 2026 --by ministry   # the filters of search and export
ka stats --no-disk --json  # without the per-file stats, for a script
ka schema                  # the JSON Schema of a record
ka reindex                 # rebuild the index from the stored records
```

`ka stats` counts from the catalog, without reading a record:

```
2471 record(s) in /Volumes/kadisk2/openka
1616 parse-complete (65.4%), 855 with abstained fields
  berlin: 2471 record(s), 855 needing review
Coverage: asked 2026-01-02 to 2026-09-30 (3 without a question date); 27,457 questions; 310 without an answer date
Abstained most: qa[].answer 1,204, dates.answered 310, askers 12 (`ka review --group-by field`)
Extractor: pkg:0.6.0+extract:0992e8afa678  2471 record(s) (this build)
On disk: blobs 270 MB in 2,471 file(s), records 41 MB in 2,471 file(s), index 18 MB in 256 file(s); 329 MB in all, 133 KB per Anfrage
  berlin: 2,471 document(s), 270 MB (avg 110 KB)
```

More than one `Extractor:` line means some records were made by another build; `ka
reextract --all` brings them to this one. Disk use lists every file of the corpus (one
`stat` each) and is on by default; `--no-disk` leaves it out. With filters it is still
the whole corpus's.

`--by` breaks the records down by `party`, `ministry`, `month`, `year`, `period` or
`parliament`, or crosses two (`--by party --by year`), into a table of records and how
many of them need review. A party is grouped across its spellings (Bayern's "GRU" and
Hessen's "BÜNDNIS 90/DIE GRÜNEN" are one party) and shown in the spelling most records
use; a question asked by two parties counts for both, and a note says so. Months, years
and periods run forward, with `(undated)` last; the rest are ordered by size. The
filters `ka search` and `ka export` take (`--parliament`, `--party`, `--year`,
`--period`, `--from`, `--to`) narrow every number but the disk use. `--json` adds
`coverage`, `extractor_versions`, `abstained_by_field`, `disk` and, with `--by`,
`breakdown` (`by`, `rows` of `keys`, `records`, `needs_review`, and `overlapping`).

The ministry, the number of questions, the extractor version and the parties as
written are part of each catalog row since 2026-10-08. A corpus catalogued before
counts those rows apart — `(not indexed)`, "not counted yet" — until `ka reindex`.

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
| 1 | an error: an upstream failure, a failed verification, a missing record, a sync `ka status --stalled-after` finds stalled |
| 2 | a usage error (a rejected option value, a malformed record id, an unknown command) |
| 3 | a corpus problem: missing or unreadable (a `--corpus` that does not exist included), held by another run, on a refused filesystem or short of free space (`ka sync`), or anything `ka doctor` calls a problem |
| 4 | the upstream returned 404 |
| 5 | `ka verify`: every content reproduces, but some records carry another build's extractor version (`ka reextract` restamps them) |
| 130 / 143 | `ka sync` stopped early on Ctrl-C / SIGTERM, after saving its catalog |
