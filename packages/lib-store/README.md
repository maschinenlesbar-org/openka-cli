# @maschinenlesbar.org/openka-lib-store

> The corpus: content-addressed blobs, canonical records, a catalog and an inverted index.

```
<root>/
  blobs/<sha[0:2]>/<sha>.bin   content-addressed source documents
  records/<id>.json            canonical records, one file each
  index/catalog.json           denormalised rows for filtering and listing
  index/tokens/<shard>.json    inverted index shards
  lock                         held while a run writes: pid, host and purpose
  run/status.json              what the running sync is doing, or what the last one did
  state/queues/<key>.json      a plan file's open round: the jobs done in it
```

**One writer at a time.** `FileStore.lock(purpose)` creates `lock` exclusively and
returns its release; `withCorpusLock(store, purpose, work)` is the usual way in.
`sync()`, `reindexAll` and `markHumanVerified` hold it, so a second writer gets
`CorpusLockedError` (a `StoreError`, exit 3 in `ka`) instead of interleaving its
writes — two concurrent syncs used to lose index postings and catalog rows while
both reported success. Readers do not take it. The lock is re-entrant per store
object; a lock whose process on this host is gone (a killed run) is taken over, one
from another host is never — the error names the file to delete.

**Files the store never wrote are skipped when they belong to the platform.**
macOS writes an AppleDouble companion (`._<name>`) beside every file on a volume
without extended attributes (FAT32, exFAT), and Finder leaves `.DS_Store`. Every
listing (`recordIds`, `shardNames`, `sourceStateKeys`) skips them (`isPlatformFile`)
and remembers their paths (`FileStore.ignoredFiles()`); `ka` names them once. Any
other record file that is not a record id is still a `StoreError`. After `lock()`,
`writesAppleDouble` says whether this is such a volume — the lock file's own `._lock`
companion is the probe.

**What the corpus is on.** `checkCorpusVolumes(location, { allowFilesystems,
minFreeBytes, probe })` reports per volume — the root, and the blob directory when it is
apart — the filesystem (`FilesystemInfo`: the system's name and a `FilesystemKind`),
the free space, and `problems` (FAT32/exFAT unless allowed; less than `minFreeBytes`,
default `DEFAULT_MIN_FREE_BYTES` = 1 GB) and `warnings` (a network filesystem).
`spaceGuard(location, minFreeBytes, probe)` is the `SpaceGuard` a sync checks as it goes:
`fitProblem(bytes)` before the first download, `lowProblem()` before each Anfrage.
`systemVolumes` is the real `VolumeProbe` (statfs for space; `mount` on macOS, the
statfs magic on Linux for the type); a path not created yet is answered for its
nearest existing ancestor. `parseByteSize`/`byteSizeProblem` read `--min-free`, and
`formatBytes` prints sizes in the same decimal units.

**The doctor.** `diagnoseCorpus(store, options)` combines the volume check, the blob
drive (`blobStoreProblem`), `lockStatus()`, `catalogGaps` and a count of the platform
files anywhere in the corpus (`platformFiles`) into problems and warnings, writing
nothing. `removePlatformFiles(store)` deletes those files under the corpus lock.

**Credentials, apart from the corpus.** `CredentialStore` keeps named credentials
(`bund.api-key`) in one JSON file, `resolveCredentialsPath(env)` =
`$XDG_CONFIG_HOME/openka/credentials`, else `$HOME/.config/openka/credentials`. It is
written atomically with mode 0600 in a directory of mode 0700. Read, it must be a
regular file owned by this user that no one else can read, or it is a `StoreError`
naming the fix. `assertOutside(corpusRoot)` refuses a file inside a corpus;
`credentialNameProblem`, `credentialValueProblem` and `maskCredential` are the rules
`ka config` uses.

**A running sync's status.** `RunStatusRecorder` writes `run/status.json`
(`getRunStatus`/`putRunStatus`, replaced atomically) as a sync goes — on each job's
start, discovery and end, and at most every `RUN_STATUS_EVERY_MS` in between, with
progress samples over the last `RATE_WINDOW_MS` — and leaves it with the run's result.
A write that fails is reported once (`onError`) and never thrown. `readRunReport`
joins it with `lockStatus()` (which now also gives the holder's pid, host and purpose):
`running`, `idle` (with the last run), `stale` (the lock's process on this host is gone)
or `busy` (another writer), each job with `rate_per_min`, `eta_seconds` and
`quiet_seconds`. `parseDurationSeconds`/`durationProblem` read `--stalled-after`.

**A plan's progress.** `getQueueProgress(key)`/`putQueueProgress(key, progress)` keep
which jobs of a plan file (`ka sync --plan`) are done in its open round, under
`state/queues/<key>.json`; `queueProgressKey(planPath)` derives the key from the plan's
absolute path, and `undefined` closes the round.

**What `ka stats` counts, in the catalog.** A catalog row also carries the askers'
parties as written (`party_labels`), the answering `ministry`, the number of
`questions` and the `extractor_version` (since 2026-10-08), so `corpusStats` can give
coverage, questions and versions, and lib-search's `statsBreakdown` its `--by` tables,
without reading a record. A row catalogued before lacks them; `ka reindex` adds them.

**Abstentions by kind, in the catalog.** A catalog row carries `abstained_fields`: the
record's abstained paths by kind (`abstainedFieldKind`: `qa[3].answer` → `qa[].answer`)
with their counts, so `corpusStats` (`abstained_by_field` per parliament) and
`reviewGroups` (lib-search) group without reading a record. A row catalogued before
it existed lacks it (`abstained_fields_unknown`); `ka reindex` adds it.

**Waiting for the lock.** `lockCorpus(store, purpose, { wait: true })` polls every
`LOCK_POLL_MS` while another run holds the corpus, says so once (`onWaiting`, with the
holder from `CorpusLockedError.holder`) and stops on an aborted `signal`; without `wait`
it is `store.lock`. `ka sync --wait` uses it in place of a shell loop polling `pgrep`.
Catalog batches (`batchCatalog`) nest — the outermost flushes — and concurrent ones,
the syncs of one multi-source run, each flush at their own end.

**The documents can be kept apart.** `new FileStore(root, { blobs })` (and
`FileStore.open`) puts the blobs in `blobs` instead of `<root>/blobs`; `resolveBlobRoot`
reads it from `--blobs` or `OPENKA_BLOBS` (`BLOBS_ENV`). That directory is never
created: `blobStoreProblem()` names it when it is missing — an unplugged drive — and
`assertBlobStore()` throws that as a `StoreError`. `putBlob`, a missing `getBlob`,
`archivedDocument`, `sync()`, `planSync()` and `verifyRecord`/`verifyCorpus` ask first;
everything that reads only records and the index does not. A store without the method
(`Store.assertBlobStore` is optional) has nothing to check.

`new FileStore(root)` opens a corpus or creates it on the first write — what a
writer wants. A reader wants `FileStore.open(root)`, which requires the corpus to be
there: a missing directory is a `MissingCorpusError`, a file a `StoreError`, rather
than an empty corpus that answers "no matches" for a mistyped path.

Everything the line persists goes through the `Store` interface, so the pipeline,
search and the CLI can be driven against an in-memory store in tests without
touching a filesystem — the same trick `Transport` plays for HTTP. The interface is
split into roles (`BlobStore`, `RecordStore`, `CatalogStore`, `IndexStore`,
`SourceStateStore`, `ArtifactStore`, `EmbeddingStore`) so a consumer can ask for the
narrow thing it needs; `Store` is their intersection.

The full-text index replaces SQLite FTS5 from the concept: the line has no runtime
dependencies and Node's built-in SQLite is not available on every supported version.
Tokenizer, scoring and sharding are pure functions, so the ranking of a search
result is reproducible and unit-testable without a filesystem.

Indexing is incremental — adding a record loads only the shards its own tokens live
in, and removing one uses the catalog row to find the same shards again, so a
deletion never scans all 256. `indexRecord` replaces a posting the record already
has rather than adding a second one, so indexing a record whose catalog row was lost
is safe. `catalogGaps(store)` compares the catalog with the record files in both
directions: record files the catalog lacks (invisible to search, stats and export)
and catalog rows whose file is gone.

## What is in here

- **`src/file-store.ts`** — The corpus on disk:  <root>/ blobs/<sha[0:2]>/<sha>.bin        content-addressed source documents records/<id>.json                 canonical records, one file each index/catalog.json                denormalised rows for filtering + listing index/tokens/<shard>.json         inverted index shards (256 of them) index/embeddings.json             frozen vectors, only if the factory shipped some state/<source>.json               per-source sync + conditional-request state  Everything is plain JSON in canonical form, so a corpus diffs cleanly in git, can be inspected with `cat`, and — crucially for
- **`src/fts.ts`** — The full-text index: tokenizer, scoring and sharding — all pure functions, so the ranking of a search result is reproducible and unit-testable without touching a filesystem.
- **`src/indexer.ts`** — Keeping the catalog and the inverted index in step with the records.
- **`src/volume.ts`** — What a corpus is stored on: the filesystem and the free space of its volumes, and the refusals a sync makes before it writes.
- **`src/credentials.ts`** — Credentials kept apart from the corpus: the user's credentials file.
- **`src/run-status.ts`** — What a running sync is doing, readable from another terminal: the status file and `ka status`'s reading of it.
- **`src/doctor.ts`** — `ka doctor`: the volumes, the lock, the catalog against the record files, and the macOS files beside them.
- **`src/stats.ts`** — `corpusStats`: what is in a corpus, counted from its catalog — the numbers `ka stats` prints, coverage and extractor versions included, over the rows `where` keeps; `corpusDiskUsage`: what it takes on disk.
- **`src/store.ts`** — The corpus seam.

## Public surface

Everything is re-exported from the package root:

```
FileStore, isSafeKey, isPlatformFile, abstainedFieldKind, RECORD_ID_REASON, recordIdProblem, assertRecordId, TITLE_BOOST, normalizeTerm, tokenize, shardOf, Posting, IndexShard, termFrequencies, scoreTerm, ParsedQuery, parseQuery, normalizeWithOffsets, containsPhrase, indexableFields, toCatalogEntry, IndexTarget, indexRecord, unindexRecord, CatalogGaps, catalogGaps, markHumanVerified, reindexAll, ParliamentStats, CorpusStats, corpusStats, CORPUS_ENV, CORPUS_DEFAULT_TEXT, CorpusRootOptions, resolveCorpusRoot, BLOBS_ENV, resolveBlobRoot, FileStoreOptions, LockCorpusOptions, LOCK_POLL_MS, lockCorpus, DiskUsage, CorpusDiskUsage, corpusDiskUsage, documentRoleProblem, ArchivedDocument, archivedDocument, CatalogEntry, SourceState, FailedRef, BlobStore, RecordStore, CatalogStore, IndexStore, SourceStateStore, ArtifactStore, EmbeddingStore, Store, LockableStore, withCorpusLock, EmbeddingSet, FilesystemKind, REFUSED_FILESYSTEMS, RefusedFilesystem, FilesystemInfo, VolumeSpace, VolumeProbe, DEFAULT_MIN_FREE_BYTES, filesystemKind, existingAncestor, parseMountLine, mountFor, systemVolumes, VolumeRole, VolumeCheckOptions, VolumeReport, CorpusLocation, blobsApart, checkCorpusVolumes, SpaceGuard, spaceGuard, parseByteSize, byteSizeProblem, formatBytes, CorpusDiagnosis, diagnoseCorpus, platformFiles, removePlatformFiles, QueueProgress, queueProgressKey, CredentialStore, resolveCredentialsPath, credentialNameProblem, credentialValueProblem, maskCredential, RunStatus, JobStatus, JobState, JobEnd, RunResult, RunStatusRecorder, RUN_STATUS_EVERY_MS, RATE_WINDOW_MS, RunReport, JobReport, readRunReport, parseDurationSeconds, durationProblem
```

## Depends on

- `lib-errors` — the shared error hierarchy
- `lib-models` — the canonical record schema, validators and the parliament table
- `lib-repro` — canonical JSON, hashing and the extractor version stamp

## Tests

Its tests live in `lib-search`'s suite (`test/store.test.ts`), which exercises the store and the search built on it together.
