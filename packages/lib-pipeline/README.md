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
SYNC_LIMIT_MIN, normalizeSyncWindow, syncLimitProblem, syncPeriodProblem, SyncWindow
```

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
