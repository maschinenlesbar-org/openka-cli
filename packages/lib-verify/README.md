# @maschinenlesbar.org/openka-lib-verify

> Proving reproducibility on demand.

This is the package behind `ka verify`, the command that makes the project's central
claim checkable rather than asserted: take a stored record, re-run its extraction
from the archived bytes, and compare the canonical JSON byte for byte. Anything
other than an exact match is a finding.

It is a package of its own for a structural reason. Verification needs
`lib-extract` and `lib-store`, and `lib-extract` needs `lib-repro` for the version
stamp. With verification inside `lib-repro` — where it used to live — that is a
dependency cycle. Separating the primitive (hash, canonical JSON, stamp) from the
service (re-extract and compare) breaks it.

## Public surface

Everything is re-exported from the package root:

```
VerifyResult, VerifyOptions, verifyRecord, diffPaths
```

## Depends on

- `lib-extract` — the deterministic tier stack
- `lib-models` — the canonical record schema, validators and the parliament table
- `lib-perceive` — the Perceiver seam (OCR)
- `lib-repro` — canonical JSON, hashing and the extractor version stamp
- `lib-store` — the corpus seam

## Tests

Covered by the workspace integration suite in the repository root's `test/pipeline.test.ts`, which verifies real goldens end to end.
