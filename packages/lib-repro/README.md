# @maschinenlesbar.org/openka-lib-repro

> The byte-level foundation of the reproducibility guarantee.

"Same input → byte-identical output" only means something if two runs that produce
the same *value* also produce the same *bytes*. `JSON.stringify` does not guarantee
that — key order follows insertion order, which follows whatever order a parser
happened to fill an object in — so every record is serialised here with keys sorted
lexicographically.

The other half is the stamp. A record is only reproducible if you can find the code
that produced it, so `extractor_version` has to identify that code exactly. In a
release build it is the git sha the factory froze; otherwise it is the package
version **plus** a digest of the frozen extraction sources, because the package
version does not move when a segmentation rule does — which is how a corpus once
ended up with two different readings under one version.

`extraction-digest.ts` is **generated**. Run `npm run stamp` after changing
extraction code; a test fails until you do.

This package is deliberately a leaf. `verify` — re-extract an archived record and
compare — used to live here and needed `lib-extract` and `lib-store`, while
`lib-extract` needs this for the stamp. That is a cycle, so verification moved to
`lib-verify` and the primitive stayed here.

## What is in here

- **`src/canonical.ts`** — Canonical JSON — the byte-level foundation of the reproducibility guarantee.
- **`src/extraction-digest.ts`** — GENERATED — do not edit by hand.
- **`src/hash.ts`** — Hashing helpers.
- **`src/version.ts`** — The extractor version stamped into every record.

## Public surface

Everything is re-exported from the package root:

```
JsonValue, canonicalJson, canonicalJsonLine, EXTRACTION_DIGEST, sha256, sha256Canonical, isSha256, VERSION_ENV, PACKAGE_VERSION, extractorVersion
```

## Depends on

Nothing. This is a leaf of the dependency graph.

## Tests

Covered by `lib-models`' test suite, which is where the canonical-JSON and digest assertions live.
