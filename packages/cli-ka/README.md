# @maschinenlesbar.org/openka-cli-ka

> `ka` — the read/write CLI over a corpus.

`sync` ingests, `search`/`get`/`show`/`open` read, `export`/`feed`/`schema` get data
out in bulk, and `verify`/`review`/`reindex`/`sources` keep the corpus honest about
itself.

**Nothing here touches the world directly.** Everything the CLI reads or writes goes
through a deps object — store factory, engine factory, `out`/`err`, `env`, `now` —
so the whole program can be driven in-process by a test with a temporary corpus, a
mocked transport and captured output. No subprocess, no network, no clock.

`run.ts` returns an exit code rather than calling `process.exit`, which is what makes
that possible. Exit codes: `0` success, `1` error, `2` usage error, `3` corpus
problem, `4` not found.

**Every option that takes a value gets a parser.** A blank filter is a usage error,
never a silently dropped constraint — a search that quietly ignores `--parliament ""`
returns the whole corpus and looks like it worked.

The test harness that builds a `CliDeps` lives in `test/harness.ts` rather than in
`lib-testing`, because the shared helpers must not depend on the CLI whose own tests
use them.

## What is in here

- **`src/commands/maintain.ts`** — `verify`, `review`, `reindex` and `sources` — the commands that keep the corpus honest about itself.
- **`src/commands/output.ts`** — `export`, `feed` and `schema` — getting the corpus out in bulk.
- **`src/commands/query.ts`** — The read side: `search`, `get`, `show` and `open`.
- **`src/commands/sync.ts`** — `ka sync` — the ingest command.
- **`src/io.ts`** — I/O seam for the CLI.
- **`src/program.ts`** — Assembles the `ka` command tree from injectable deps.
- **`src/run.ts`** — Parse argv, run the command, return an exit code.
- **`src/shared.ts`** — Shared CLI helpers: option parsers, global-option resolution, and the few rendering paths every command group uses.
- **`src/text.ts`** — Text helpers shared by the CLI's output paths.

## Public surface

Everything is re-exported from the package root:

```
evenSample, registerMaintain, registerOutput, renderShowLines, registerQuery, OCR_MODES, OcrMode, buildPerceiver, registerSync, CliIO, CliDeps, defaultIO, defaultDeps, buildProgram, EXIT_OK, EXIT_ERROR, EXIT_USAGE, EXIT_STORE, EXIT_NOT_FOUND, run, CORPUS_ENV, defaultCorpusRoot, parseBoundedInt, parseNonEmpty, parseIsoDate, collect, collectInt, GlobalOptions, toEngineOptions, ActionContext, action, printJson, emit, addCorpusFilters, corpusFiltersFrom, choiceOption, addGlobalOptions, escapeControlChars, sanitizeForTerminal, truncate, pad
```

## Depends on

- `lib-errors` — the shared error hierarchy
- `lib-http` — the Transport seam and the fetch engine
- `lib-models` — the canonical record schema, validators and the parliament table
- `lib-perceive` — the Perceiver seam (OCR)
- `lib-pipeline` — discover → fetch → extract → normalize → store
- `lib-registry` — the source registry
- `lib-render` — the output renderers
- `lib-repro` — canonical JSON, hashing and the extractor version stamp
- `lib-search` — keyword and semantic search
- `lib-store` — the corpus seam
- `lib-text` — control-character stripping
- `lib-verify` — re-extract-and-compare, behind `ka verify`
- `commander` — argument parsing — the only third-party runtime dependency in the project

## Tests

`test/cli.test.ts` — run with:

```bash
npm test -w @maschinenlesbar.org/openka-cli-ka
```
