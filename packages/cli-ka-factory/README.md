# @maschinenlesbar.org/openka-cli-ka-factory

> `ka-factory` — build-time tooling, deliberately unreachable from the line.

Separate binary, separate command tree, and **nothing on the line may import it** —
`ka-factory lint` enforces exactly that, and since the split into workspaces it is
also a package boundary: no line package declares this as a dependency.

What lives here is everything the concept puts on the factory plane:

- **`lint`** — the guardrail. No package except this one may import an LLM client,
  mention a model provider's host, or import the factory. Its roots are discovered
  from `packages/`, so a new connector is covered the moment it exists.
- **`goldens`** — frozen input→record pairs. Because the line is deterministic these
  are real asserts, not fuzzy eval scores. Each Land's goldens live in its own
  connector package; `goldens verify` finds them all from the workspace root.
- **`stamp`** — computes the extraction digest that `extractor_version` carries. It
  hashes the *sources* of `lib-extract`, `lib-pdf`, `lib-perceive` and `lib-text`
  with comments and indentation stripped, because an earlier attempt that hashed
  only the named constants missed a rule change and produced two readings under one
  version.
- **`health`** — coverage and drift signals. Not pass/fail: these tell the factory
  *when* to do work.
- **`embed`** — frozen embeddings, computed here and consumed by the line, which
  never embeds anything at runtime.
- **`answers niedersachsen`** — the Drucksachen sweep that recovers a link no
  interface exposes.

It depends on `cli-ka` for the shared I/O seam and option parsers, and on
`connector-niedersachsen` for the sweep. Both are allowed: the factory may depend on
the line, never the other way round.

## What is in here

- **`src/cli/program.ts`** — `ka-factory` — the build-time tooling.
- **`src/cli/run.ts`** — argv in, exit code out — the factory's equivalent of `src/cli/run.ts`.
- **`src/lib/answer-index.ts`** — The Niedersachsen answer sweep — a build-time job that recovers a link no interface exposes.
- **`src/lib/embed.ts`** — Frozen embeddings, built in the factory, consumed by the line.
- **`src/lib/goldens.ts`** — Golden fixtures: a verified input→record pair, frozen on disk.
- **`src/lib/health.ts`** — Coverage and health metrics, and the drift signals derived from them.
- **`src/lib/lint.ts`** — The guardrail that makes "no generative model on the line" a checkable property rather than a promise in a document.
- **`src/lib/stamp.ts`** — Computing the extraction digest that `extractor_version` carries.

## Public surface

Everything is re-exported from the package root:

```
DEFAULT_FIXTURES, DEFAULT_BASELINE, buildFactoryProgram, runFactory, SweepOptions, SweepReport, sweepAnswers, HASHED_TFIDF, DEFAULT_DIMENSIONS, buildEmbeddings, importEmbeddings, GoldenMeta, Golden, workspaceRoot, goldenRoots, listAllGoldens, listGoldens, addGolden, GoldenResult, verifyGolden, SourceHealth, HealthSnapshot, measureHealth, loadBaseline, saveBaseline, DriftKind, DriftFinding, ABSTENTION_SPIKE, QA_COLLAPSE, detectDrift, FACTORY_PACKAGE, LINE_FILES, lineRoots, FORBIDDEN_MODULES, FORBIDDEN_HOSTS, LintViolation, lineFiles, lintSource, stripComments, LintReport, lintLine, EXTRACTION_SOURCES, extractionSourceFiles, computeExtractionDigest
```

## Depends on

- `cli-ka` — the `ka` command tree and its I/O seam
- `connector-niedersachsen` — the niedersachsen connector
- `lib-errors` — the shared error hierarchy
- `lib-extract` — the deterministic tier stack
- `lib-http` — the Transport seam and the fetch engine
- `lib-models` — the canonical record schema, validators and the parliament table
- `lib-pdf` — the PDF reader
- `lib-perceive` — the Perceiver seam (OCR)
- `lib-pipeline` — discover → fetch → extract → normalize → store
- `lib-registry` — the source registry
- `lib-repro` — canonical JSON, hashing and the extractor version stamp
- `lib-store` — the corpus seam
- `lib-verify` — re-extract-and-compare, behind `ka verify`
- `commander` — argument parsing — the only third-party runtime dependency in the project

## Tests

`test/factory.test.ts` — run with:

```bash
npm test -w @maschinenlesbar.org/openka-cli-ka-factory
```
