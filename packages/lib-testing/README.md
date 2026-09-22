# @maschinenlesbar.org/openka-lib-testing

> The seams, pre-wired: an in-memory store, a scripted transport, and fixture access.

Everything here exists so a test can drive the real code end to end without a
network, a subprocess or a clock. It is private and never ships on the line.

`fixtures(import.meta.url)` resolves the **calling package's** own `fixtures/`
directory, because each package keeps its fixtures beside its tests.
`fixturesOf(packageName, import.meta.url)` resolves another package's, for the few
payloads two packages genuinely share — the recorded PARDOK export is both the
format's reference fixture and Berlin's feed. One copy of the bytes on disk, and the
borrowing is visible as a devDependency.

`PROJECT_ROOT` is the workspace root, for the handful of tests that are about the
repository itself rather than about a record: the guardrail lint walks every
package's sources, and the extraction digest is a hash over them.

The CLI harness is **not** here. It builds a `CliDeps`, so putting it here would make
the shared helpers depend on `cli-ka` — whose own tests use these helpers. It lives
in `packages/cli-ka/test/harness.ts` instead.

## Public surface

Everything is re-exported from the package root:

```
PROJECT_ROOT, fixturesOf, fixtures, MemoryStore, ScriptedRoute, ScriptedTransport, scriptedTransport, testEngine, sampleRecord, questionPaper
```

## Depends on

- `lib-http` — the Transport seam and the fetch engine
- `lib-models` — the canonical record schema, validators and the parliament table
- `lib-repro` — canonical JSON, hashing and the extractor version stamp
- `lib-store` — the corpus seam

## Tests

No tests of its own; it is the thing the other suites are written with.
