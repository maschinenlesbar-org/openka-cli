# @maschinenlesbar.org/openka-lib-perceive

> The only place a trained model may run on the line.

A Perceiver is narrow and perceptual: image in, characters out. The seam exists to
make four rules checkable — deterministic inference with fixed weights and a greedy
decode, a version-locked engine, hashed weights recorded in the record's
`model_artifacts`, and the obligation to abstain rather than guess.

Two implementations: a pinned Tesseract binary on `PATH`, and `tesseract.js`, the
WASM build of the same engine. The latter is an **optional peer dependency** —
nothing installs it for you, so the line keeps its zero-required-runtime-dependency
property — and it is imported dynamically, so a corpus built without OCR never loads
a 10 MB WASM module.

This package is part of the **extraction digest**: changing it changes what a
document turns into, so `npm run stamp` and a golden re-freeze are required.

**These tests never touch the host's Tesseract, and no test anywhere should.** The
suite drives a stub `tesseract` written to a temp directory and an injected
`tesseract.js` module. `lib-extract` used to carry two tests against the real binary
instead: one passed only on a machine that happened to have Tesseract installed and
failed in CI, the other guarded itself with `t.skip` and therefore never ran there at
all. A test whose result depends on what is installed is either a false failure or
dead coverage wearing a green tick.

## What is in here

- **`src/perceiver.ts`** — The only place a trained model may run on the line (CONCEPT.md §6).
- **`src/tesseract-cli.ts`** — OCR through a pinned Tesseract binary on PATH.
- **`src/tesseract-js.ts`** — OCR through `tesseract.js`, the WASM build of the same engine.

## Public surface

Everything is re-exported from the package root:

```
PerceiveInput, PerceiveOutput, Perceiver, abstainingPerceiver, TesseractOptions, TesseractCliPerceiver, TesseractJsOptions, TesseractJsPerceiver
```

## Depends on

- `lib-errors` — the shared error hierarchy
- `lib-models` — the canonical record schema, validators and the parliament table
- `lib-repro` — canonical JSON, hashing and the extractor version stamp

## Tests

No tests of its own; the provenance and determinism assertions live in `lib-extract`'s suite, next to the tier that calls it.
