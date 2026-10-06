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
CATALOG_CHECKPOINT, SYNC_LIMIT_MIN, normalizeSyncWindow, syncLimitProblem, syncPeriodProblem, SyncWindow,
syncSources, SyncSourcesOptions, SourceOutcome, planLanes, sourceListProblem,
planSync, SyncPlanOptions, SyncPlan, SizeEstimate, DRY_RUN_SAMPLE, ESTIMATE_MIN_KNOWN
```

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

## Progress

`onDiscovered(count)` is called once discovery is done, with the number of refs the
run will handle, and `onProgress(event)` after each ref with its `index` of `total`
and what happened to it. `ka sync` builds its progress line from the two; it used to
have no total until the first record and printed nothing but failures.

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

A document that now answers 404, or that robots.txt now disallows, is a gap only for
a record that never had it. A record that already holds it keeps it: the pipeline
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
