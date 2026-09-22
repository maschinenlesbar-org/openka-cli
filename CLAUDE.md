# CLAUDE.md

Guidance for Claude Code working in this repository. Read [CONCEPT.md](CONCEPT.md)
first — it is the spec — then [DEVELOPING.md](DEVELOPING.md) for the implementation.

## The one rule everything else follows from

**No generative model may run on the line.** Every workspace package except
`packages/cli-ka-factory` is the line. They may not import an LLM client, reach a model
provider's host, or import anything from the factory package. `ka-factory lint` enforces
this and runs in CI.

You live on the factory plane. You write and repair the deterministic extractors,
propose golden fixtures, and run the heal loop. Your output is frozen code, not a
runtime call.

## Abstain, never guess

When an extractor cannot read something, it emits nothing for that field, names it
in `abstained_fields`, and sets `review_status: needs_review`. Do not "fix" an
abstention by loosening a rule until something matches — that converts a visible
hole into an invisible wrong answer, which is the failure mode this project exists
to prevent.

When you widen a rule, widen it on evidence (a real document that the rule should
have read), add the document as a golden, and check the abstention rate did not rise
elsewhere.

## Workspace layout

npm workspaces, one `tsc -b` build graph, three kinds of package under `packages/`:

- **`lib-*`** — the shared engine, one package per seam: `lib-models`, `lib-repro`,
  `lib-errors`, `lib-text`, `lib-http`, `lib-pdf`, `lib-perceive`, `lib-extract`,
  `lib-store`, `lib-search`, `lib-render`, `lib-verify`, `lib-pipeline`,
  `lib-source`, `lib-pardok`, `lib-parlamentsspiegel`, `lib-registry`, plus
  `lib-testing` for the shared test helpers.
- **`connector-*`** — one per parliament: the Bund and all sixteen Länder. A Land's
  adapter, its `ENTRY` for the registry, its tests and its fixtures live together.
  Ten Länder have no adapter of their own yet and their package holds only the
  entry that says so — that is the gap `ka sources list` shows.
- **`cli-*`** — `cli-ka` (the `ka` bin) and `cli-ka-factory` (the `ka-factory` bin).
- **`openka-cli`** — the one published package: the library entry point, the two bin
  shims, and the cross-package integration suite.

**The layout has no exceptions**: everything with source is a package under
`packages/`, and the repository root is a workspace manifest, a build graph and the
documents. Every package but `openka-cli` is `private` and is bundled into its
tarball by `tools/prepack.mjs` — read that package's README before changing anything
about packing. Each package builds to its own `dist/src` and `dist/test`.

**Each package has two TypeScript projects**: `tsconfig.json` for `src/`, which other
packages reference, and `tsconfig.test.json` for `test/`, which nothing references.
That is what lets `lib-store`'s tests use `lib-testing` even though `lib-testing`
depends on `lib-store` — without the split the references form a cycle and `tsc -b`
refuses to build.

**A test belongs to the package it exercises.** Where a test would have to reach
*up* — a connector asserting it is in the registry, which depends on it — the
assertion belongs to the package above instead; the registry's own test checks that
every connector is registered. Fixtures follow provenance: a Land's goldens and its
upstream payloads live in its connector, a Parlamentsspiegel result row lives in
`lib-parlamentsspiegel`, and a test that needs another package's fixture borrows it
with `fixturesOf(...)` rather than keeping a second copy of the bytes.

## Commands

```bash
npm run build && npm test     # 467 tests across the workspace, node:test, no network
npm run typecheck
npm run coverage              # the suite with an enforced 80% line/function floor
npm run lint:line             # the guardrail
npm run goldens               # every golden re-extracts to its frozen record
node packages/cli-ka-factory/dist/src/cli/index.js goldens verify
```

Tests hit recorded fixtures, **never live parliaments**. If you need a new upstream
payload, record one under the `fixtures/payloads/` of the package that parses it and
trim it.

## What needs review before you do it

Per CONCEPT.md §8, you may write extractors, add fixtures, and run the heal loop.
You may **not** without asking:

- change `SCHEMA_VERSION` or the shape of a published field;
- raise a rate limit or lower `minHostIntervalMs`;
- add a generative model to the line, in any form;
- promote an extractor whose goldens regressed or whose abstention rate rose;
- relax a consistency check in `segment.ts` to make a document pass.

## Conventions

- **Zero required runtime dependencies** beyond `commander`. HTTP is
  `node:http`/`https`; the PDF reader is ours; the corpus is plain files. OCR is an
  *optional peer* dependency, loaded dynamically.
- **Strict TypeScript, ESM, Node ≥ 20.** `noUncheckedIndexedAccess` is on.
- **Every CLI option that takes a value gets a parser.** A blank filter is a usage
  error, never a silently dropped constraint.
- **Nothing on the line reads the clock** except the pipeline, which stamps
  `retrieved_at` at fetch time and injects its clock through `CliDeps.now`.
- **Changing extraction bumps the extractor version.** `extractor_version` carries
  a digest of the extraction sources (`packages/lib-extract`, `packages/lib-pdf`,
  `packages/lib-perceive`, `packages/lib-text`), so *any* change to what a document turns
  into moves it — not just the named constants like `WORD_GAP_EM` or
  `MIN_NUMBER_DENSITY`. The digest is frozen in `packages/lib-repro/src/extraction-digest.ts`;
  after changing extraction code run **`npm run stamp`** and re-freeze the goldens. A
  test fails until you do. Comments and indentation are excluded, so improving a
  comment does not invalidate a corpus.
- **Comments explain judgement, not syntax.** The interesting comments in this
  repository say why a threshold is where it is, or what real document forced a
  decision. Keep that.

## The website

`site/` is the shared bilingual Jekyll kit, built by `docs.yml` on a `v*` tag. Its
content is generated from the repository — README intro, the built CLI's command
tree, `Usage.md`, `GLOSSARY.md` — so the only files to edit by hand are
`site/_config.yml` and `site/_data/project.yml`. **When the README's intro changes,
update the German one in `project.yml` in the same commit.** DEVELOPING.md explains
the two workspace-specific keys.

## Exit codes

`0` success · `1` error · `2` usage error · `3` corpus problem · `4` not found.
