# CLAUDE.md

Guidance for Claude Code working in this repository. Read [CONCEPT.md](CONCEPT.md)
first — it is the spec — then [DEVELOPING.md](DEVELOPING.md) for the implementation.

## The one rule everything else follows from

**No generative model may run on the line.** `src/core`, `src/sources`, `src/cli`
and `src/index.ts` are the line. They may not import an LLM client, reach a model
provider's host, or import anything from `src/factory`. `ka-factory lint` enforces
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

## Commands

```bash
npm run build && npm test     # 271 tests, node:test, no network
npm run typecheck
npm run lint:line             # the guardrail
node dist/src/factory/cli/index.js goldens verify
```

Tests hit recorded fixtures, **never live parliaments**. If you need a new upstream
payload, record one under `fixtures/payloads/` and trim it.

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
  a digest of the extraction sources (`src/core/extract`, `src/core/pdf`,
  `src/core/perceive`, `src/core/text.ts`), so *any* change to what a document turns
  into moves it — not just the named constants like `WORD_GAP_EM` or
  `MIN_NUMBER_DENSITY`. The digest is frozen in `src/core/repro/extraction-digest.ts`;
  after changing extraction code run **`npm run stamp`** and re-freeze the goldens. A
  test fails until you do. Comments and indentation are excluded, so improving a
  comment does not invalidate a corpus.
- **Comments explain judgement, not syntax.** The interesting comments in this
  repository say why a threshold is where it is, or what real document forced a
  decision. Keep that.

## Exit codes

`0` success · `1` error · `2` usage error · `3` corpus problem · `4` not found.
