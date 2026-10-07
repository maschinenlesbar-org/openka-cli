# @maschinenlesbar.org/openka-lib-verify

> Proving reproducibility on demand.

This is the package behind `ka verify`, the command that makes the project's central
claim checkable rather than asserted: take a stored record, re-run its extraction
from the archived bytes, and compare the canonical JSON byte for byte. Anything
other than an exact match is a finding.

What it cannot check is the discovery metadata — title, askers, `answered_by`,
`dates`, the documents' URLs (`UNCHECKED_FIELDS`): it is not archived, so
re-extraction takes it from the stored record and an edit to it reproduces.
`verifyCorpus` names those fields in the report (`unchecked`).

It is a package of its own for a structural reason. Verification needs
`lib-extract` and `lib-store`, and `lib-extract` needs `lib-repro` for the version
stamp. With verification inside `lib-repro` — where it used to live — that is a
dependency cycle. Separating the primitive (hash, canonical JSON, stamp) from the
service (re-extract and compare) breaks it.

`verifyCorpus({ store, ids?, all?, limit? })` is `ka verify`: given ids, every
record, or an even sample (`evenSample`, `DEFAULT_VERIFY_SAMPLE`), tallied as
`{ checked, reproduced, unreadable, unchecked, results }`. A record whose file will not parse is
a failed row marked `unreadable` — `verifyRecord` returns it rather than throwing —
and the run carries on past it. `assertVerified(report)` is the verdict: a
`StoreError` when anything was unreadable, else an `OpenKaError` when anything did
not reproduce.

## Public surface

Everything is re-exported from the package root:

```
UNCHECKED_FIELDS, VerifyResult, VerifyOptions, verifyRecord, DEFAULT_VERIFY_SAMPLE, evenSample, VerifyCorpusOptions, CorpusVerifyReport, verifyCorpus, assertVerified, diffPaths
```

## Depends on

- `lib-errors` — the shared error hierarchy
- `lib-extract` — the deterministic tier stack
- `lib-models` — the canonical record schema, validators and the parliament table
- `lib-perceive` — the Perceiver seam (OCR)
- `lib-repro` — canonical JSON, hashing and the extractor version stamp
- `lib-store` — the corpus seam

## Tests

Covered by the workspace integration suite in the repository root's `test/pipeline.test.ts`, which verifies real goldens end to end.
