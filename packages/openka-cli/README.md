# @maschinenlesbar.org/openka-cli

> The published package: the library entry point and the two bins.

This is the one package that ships. Everything else in the workspace is `private`
and is bundled into this tarball at pack time.

It holds almost no code:

- **`src/index.ts`** re-exports the library surface — the schema and its validators,
  the store, the deterministic extractors, the PDF reader, the source clients and
  the reproducibility checks. What is deliberately *not* exported is the factory.
- **`src/bin/ka.ts`** and **`src/bin/ka-factory.ts`** are one-line shims, so the
  tarball has a stable entry point whatever the layout underneath it is.
- **`test/pipeline.test.ts`** is the cross-package integration suite. It belongs
  here rather than to any one package because it spans them: discover → fetch →
  extract → normalize → store, and then `ka verify` against real goldens.

## Packing has one wrinkle, and it is worth knowing about

Being a workspace package like every other keeps the repository layout free of
exceptions — and costs one thing. npm bundles `bundleDependencies` from the
*package's own* `node_modules`, and in a workspace the dependencies are symlinked
into the **root** `node_modules` instead. Packing from here therefore produces a
tarball with none of them and bins that cannot resolve a single import. The failure
is silent: `npm pack` succeeds and the tarball is simply 20 kB instead of 300.

`tools/prepack.mjs` handles it. It copies each workspace dependency's manifest and
built `dist` into this package's `node_modules`, walks the dependency graph
**transitively** — bundling only the direct ones leaves half the graph missing — and
copies in the repository-level documents the tarball carries, `LICENSE` among them,
because npm cannot reach outside a package directory when it builds one. Everything
it writes is generated and gitignored; the originals stay the single source of truth.
`tools/postpack.mjs` removes it all again as soon as the tarball exists.

Three more things happen on the way, each because the registry reads the tarball
differently from a maintainer reading this directory:

- **The README is swapped.** npm shows this directory's `README.md` on the package
  page, and this file is written for whoever maintains the package, not whoever
  installs it. For the length of the pack the repository README stands in for it,
  and this one waits as `package-readme.parked.md`. A pack that dies before
  `postpack` leaves it parked; the next `prepack` puts it back first.
- **Source maps stay behind.** They point at `src/*.ts`, which the tarball does not
  carry. `files` excludes this package's own and `prepack` skips the bundled ones.
- **Bundled manifests name their licence.** A workspace package never ships alone,
  so its `package.json` has no `license`, `author` or `repository`. A consumer's
  licence scanner reads every bundled manifest on its own, so `prepack` stamps those
  fields onto each copy from this package's manifest.

`.npmignore` is only a second line of defence behind `files`. Its patterns are
anchored to this directory, because an unanchored `src/` would also match
`dist/src/`.

Verify a change to any of that the only way that means anything:

```bash
npm run pack                      # from the workspace root
cd /tmp && mkdir t && cd t && npm init -y
npm install /path/to/maschinenlesbar.org-openka-cli-<version>.tgz
./node_modules/.bin/ka sources list
```

## Depends on

- `cli-ka` — the `ka` command tree and its I/O seam
- `cli-ka-factory` — the factory tooling
- `connector-berlin` — the berlin connector
- `connector-bund` — the bund connector
- `connector-niedersachsen` — the niedersachsen connector
- `connector-nordrhein-westfalen` — the nordrhein-westfalen connector
- `connector-saarland` — the saarland connector
- `connector-sachsen` — the sachsen connector
- `connector-thueringen` — the thueringen connector
- `lib-errors` — the shared error hierarchy
- `lib-extract` — the deterministic tier stack
- `lib-http` — the Transport seam and the fetch engine
- `lib-models` — the canonical record schema, validators and the parliament table
- `lib-pardok` — the `Parlamentsspiegel Export 1.0` reader
- `lib-parlamentsspiegel` — the shared aggregator adapter
- `lib-pdf` — the PDF reader
- `lib-perceive` — the Perceiver seam (OCR)
- `lib-pipeline` — discover → fetch → extract → normalize → store
- `lib-registry` — the source registry
- `lib-render` — the output renderers
- `lib-repro` — canonical JSON, hashing and the extractor version stamp
- `lib-search` — keyword and semantic search
- `lib-source` — the `Source` protocol and the scraping helpers
- `lib-store` — the corpus seam
- `lib-verify` — re-extract-and-compare, behind `ka verify`
- `commander` — argument parsing — the only third-party runtime dependency in the project

## Tests

`test/pipeline.test.ts` — run with:

```bash
npm test -w @maschinenlesbar.org/openka-cli
```
