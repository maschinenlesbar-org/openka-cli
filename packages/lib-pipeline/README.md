# @maschinenlesbar.org/openka-lib-pipeline

> discover → fetch → extract → normalize → store.

The pipeline is idempotent and keyed on content: a document whose bytes are already
in the blob store is not re-fetched, and a record whose inputs and extractor version
are unchanged is not re-extracted. Re-running a sync over a window that has not
moved does nothing and says so.

It is the one place on the line that reads the clock, and even then it does not:
the clock is injected, so `retrieved_at` is a value the caller supplies rather than
something the extractor reaches for. That is what keeps re-extraction years later
producing the same abstentions it produced the first time.

## Public surface

Everything is re-exported from the package root:

```
SyncOptions, ProgressEvent, SyncReport, sync, isoInstant, SourceStatusRow, sourceStatus,
CATALOG_CHECKPOINT, SYNC_LIMIT_MIN, normalizeSyncWindow, syncLimitProblem, syncPeriodProblem, syncRefsProblem, isSelective, SyncWindow,
selectRefs, RefSelection, isComplete, noteOutcome, refIs, sameReference,
syncSources, SyncSourcesOptions, SourceOutcome, planLanes, sourceListProblem,
syncJobs, SyncJob, SyncJobsOptions, jobListProblem,
SyncJobSpec, jobLabel, parseJobSpec, jobSpecProblem, withDefaults, windowOf,
SyncQueue, QueueJob, parseSyncQueue, JOB_KEYS, DEFAULT_KEYS, LOG_PLACEHOLDERS,
parseToml, TomlDocument, TomlTable, TomlValue,
planSync, SyncPlanOptions, SyncPlan, SizeEstimate, DRY_RUN_SAMPLE, ESTIMATE_MIN_KNOWN, documentsToFetch, corpusEstimate,
countSources, CountSourcesOptions, SourceCountRow
```

**Only some of a window** (issue #27). A `SyncWindow` also says which of the Anfragen
discovery finds are handled: `refs`, `retryFailed` and `onlyNew` (`src/select.ts`,
`selectRefs`). The rest cost no request and are counted in `SyncReport.skipped`. Every
run keeps the refs it failed on in `SourceState.failed` (lib-store) until a later run
handles them, and `retryFailed` takes those. A selective run discovers with `force`, since
a feed's 304 lists nothing to select from. It restores the source's own validators like an
interrupted run does, since it did not cover the window. `jobLabel`/`parseJobSpec` write
the selection as `ref=…`, `retry-failed` and `only-new`, and a plan as `ref`,
`retry_failed` and `only_new`.

**Upstream beside the corpus.** `countSources({ sources, store, engineFor, period? })`
(`src/count.ts`) asks each source's `count()`, one after the other, and sets the
corpus's records for that parliament (all Länder for an aggregator; the same period
when one is given) beside it, with what is missing. A source that cannot count, or not
as asked, gets a `note` (and its `error`, for a caller that rethrows) instead of a
number. `ka sources count` prints it.

**A plan instead of a run.** `planSync({ source, store, engine, …window })`
(`src/plan.ts`) runs discovery only — bypassing the feed's validators, since a 304 says
nothing about what a window holds — and returns how many Anfragen it found, how many the
corpus has, how many document URLs a sync would download, and an estimate of their size:
the average of the source's archived documents once there are `ESTIMATE_MIN_KNOWN`,
otherwise `Content-Length` from HEAD requests to up to `DRY_RUN_SAMPLE` of them, under
robots.txt and the source's pacing. It reads the store and writes nothing.

**Several sources in one run.** `syncSources({ sources, engineFor, … })` holds the
corpus lock once and runs the sources side by side (`src/many.ts`). Each gets its own
engine from `engineFor`, because `sync()` raises an engine's interval to the source's
floor for good; build them on one `HostPacer` (lib-http) so a host two sources reach is
paced once. Sources of one parliament share a lane and run one after the other, since
two runs writing one record id would index against each other's stale copy; an
aggregator tied to no parliament runs alone, after the lanes (`planLanes`). The window
applies to every source and is checked once, up front; a list that is empty or names a
source twice is refused (`sourceListProblem`). A failing source is that source's
outcome (`{ status: "failed", error }`), not the end of the run; an aborted `signal`
stops the running ones between refs and marks the rest `skipped`.

**Jobs: a window per source.** `syncJobs({ jobs, … })` is the same run over jobs, each
a source with a window of its own and a `label` (`jobLabel`: `bund@period=21`, or the
key alone); `syncSources` is its special case of one job per source over one window.
One source may be several jobs; they share its lane and run in order. The labels name
the jobs in the callbacks and in each `SourceOutcome` (`job`), and may not repeat
(`jobListProblem`). `stopOnFailure` starts no job once one has failed; the rest are
`skipped` with `reason: "after-failure"` (an aborted signal's are `"interrupted"`).
`parseJobSpec("bund@2026-01-01..,limit=50")` reads the command-line form, and
`withDefaults` fills a job's window from shared defaults field by field.

**A plan file.** `parseSyncQueue(text, { where, sourceProblem })` reads a queue of
`[[job]]` tables and one `[defaults]` (`src/queue.ts`): a list of periods becomes
one job per period, `log` templates are filled in (`LOG_PLACEHOLDERS`), and an unknown
key, a bad window, an unknown source or a repeated job is a `UsageError` naming the file,
the job and the field. The file is read by `parseToml` (`src/toml.ts`), the subset of
TOML a plan needs: no dependency, and what it does not read is refused by name.

`sync()` checks its window first (`normalizeSyncWindow`, `src/window.ts`): calendar
dates for `since`/`until` (trimmed), `until` not before `since`, `period` in
`PERIOD_RANGE`, `limit` >= `SYNC_LIMIT_MIN`. A bad one rejects with
`OpenKaValidationError` before any request and is not recorded as a source error.

A source's politeness floor (`Source.minHostIntervalMs`, 4000 ms for Brandenburg and
Sachsen-Anhalt) is applied by `sync()` itself, before discovery:
`engine.raiseMinHostInterval` raises the engine's interval to it and never lowers
it, for every host the source reaches, and it stays raised on that engine.

`sourceStatus(store, registry)` (`src/status.ts`) is the table `ka sources list`
prints: each registry entry with its record count and last sync state.

## An interrupted run

The catalog is saved every `CATALOG_CHECKPOINT` (25) refs, not once at the end, so a
run killed outright loses the catalog rows of at most that many stored records.
`signal` (an `AbortSignal`) stops a run between two refs: the ref in hand is
finished, the catalog saved, and the report says `interrupted: true`; the source's
`last_success` is left as it was. A record that is unchanged but has no catalog row —
what an interrupted run left behind, before the checkpoints — is indexed again and
counted in `recatalogued`, so the next sync over the window repairs it; before, every
later run called it "unchanged" and it stayed invisible to search, stats and export.

## A document over the size cap

A document larger than the engine's `maxResponseBytes` is a gap in its record, like
one that answers 404 (`gap: "too-large"`): the record is stored with what is known and
abstains on what the document would have given, and the warning names the size and the
`--max-response-bytes` that fetches it. It used to fail the whole Anfrage, which was then
missing from the corpus (issue #23). `planSync` warns for sampled documents whose
`Content-Length` is over the cap.

## A run that runs out of room

`space` (a `SpaceGuard`, `spaceGuard` in lib-store) guards the disk. After discovery,
before the first download, a run whose documents to fetch (`documentsToFetch`) would
not fit beside the floor is refused with `StoreError`. The size is
`corpusEstimate`: the average of what the source already archived, so no request is
made and a first sync is not estimated. Before each ref, a volume below the floor
stops the run the way `signal` does — the catalog saved, `last_success` and
`last_error` left as they were — and the report says why in `lowSpace`.

## Progress

`onDiscovered(count)` is called once discovery is done, with the number of refs the
run will handle, and `onProgress(event)` after each ref with its `index` of `total`
and what happened to it. `ka sync` builds its progress line from the two; it used to
have no total until the first record and printed nothing but failures.

Each event also says how long the Anfrage took (`ms`), what it downloaded (`bytes`),
the fields a stored record abstains on (`abstained`) and the documents that were not
fetched, with their URL and why (`gaps`, `DocumentGap`) — what `ka sync`'s JSON Lines log
writes per record (issue #10). Each event carries `timing` (`SyncTiming`), and the report the final one: the requests,
retries and 429/503 answers since the run began and the time inside them (average and
95th percentile), from the engine's `metrics` (lib-http); the time spent waiting before
requests; and the time the pipeline spent extracting and storing, on its clock
(`now`). It is what says whether a slow run waits on the upstream, on politeness or on
extraction (issue #14).

## A person's mark

A record a person marked `human_verified` keeps the mark when it is re-extracted
(`force`, an extractor upgrade) into the same content — equal apart from the mark and
the documents' `retrieved_at`. When the content changed, the mark is dropped and the
report carries a warning naming the record.

## robots.txt

Every document URL is checked against its host's `robots.txt` before it is fetched,
whichever source produced it — a Brandenburg PDF reaches this pipeline through
`--source brandenburg` *and* through `--source parlamentsspiegel`, and the rule has to
hold at the fetch. The file is read once per host per run (`RobotsPolicy` in
`lib-source`), a 404 means nothing is disallowed, and the rules are matched against the
User-Agent the engine sends. A disallowed document is a gap in the record, named in
`abstained_fields`, with one warning per host in the report. `ignoreRobots` fetches
anyway, warns once per host that it did, and slows that host to one request every four
seconds for the rest of the run.

## A document that goes away

A document that now answers 404, that robots.txt now disallows, or that answers with
something that is not a PDF (no `%PDF-` header — an HTML error page served with 200) is
a gap only for a record that never had it; the HTML is not archived as the paper. A record that already holds it keeps it: the pipeline
reads the archived bytes again (dated when they were actually retrieved), so an
unchanged record stays unchanged and the report carries a warning naming the URL. If
the archived bytes are missing too, the ref fails with an error and the stored record
is left as it was — a transient 404 or a robots.txt change never empties a corpus.

## Depends on

- `lib-errors` — the shared error hierarchy
- `lib-extract` — the deterministic tier stack
- `lib-http` — the Transport seam and the fetch engine
- `lib-models` — the canonical record schema, validators and the parliament table
- `lib-perceive` — the Perceiver seam (OCR)
- `lib-repro` — canonical JSON, hashing and the extractor version stamp
- `lib-source` — the `Source` protocol and the scraping helpers
- `lib-store` — the corpus seam

## Tests

Covered by the workspace integration suite in the repository root's `test/pipeline.test.ts`, which drives discovery, fetch, extraction and storage against recorded payloads.
