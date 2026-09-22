# @maschinenlesbar.org/openka-lib-extract

> The deterministic tier stack, the frozen segmentation rules, and the last gate before a record is published.

One entry point, `extract()`, runs the tier an adapter declared. Every tier is a
pure function of its inputs — the document bytes, the metadata the source supplied,
and the extractor version — so re-running it yields byte-identical output. That is
what `ka verify` checks.

**The segmentation rules are written to fail loudly.** A rule set either recognises a
document's structure completely enough to pass its own consistency checks, or it
abstains for the whole document. It never emits the half it understood. The guards
are frozen constants — a minimum number density, a maximum gap in a numbered list, a
minimum answer rate for a long question list — and each one is there because a real
document forced it.

**Metadata rules return `undefined` rather than a best guess.** Callers turn that
into an abstention.

**Validators never repair.** They answer one question — "is this value possible?" —
and when the answer is no the field is dropped and named in `abstained_fields`. An
answered document with no answering ministry abstains; an *unanswered* one does not,
because "we do not know" and "there is none" are different facts.

This package is part of the **extraction digest**: changing it changes what a
document turns into, so `npm run stamp` and a golden re-freeze are required.

## What is in here

- **`src/metadata.ts`** — Deterministic metadata rules over a document's plain text: German dates, Drucksachen references, askers, the answering ministry, and the document markers.
- **`src/segment.ts`** — Frozen segmentation rules: plain text of a Kleine Anfrage in, question/answer pairs out.
- **`src/tiers.ts`** — The deterministic tier stack with its abstention path (CONCEPT.md §5).
- **`src/validators.ts`** — Post-extraction validators: the last gate before a record is published.

## Public surface

Everything is re-exported from the package root:

```
parseGermanDate, findDate, findReference, periodFromReference, ParsedAsker, ParsedUrheber, parseUrheber, DocumentMarkers, findMarkers, findMinistry, SegmentationRules, FRAGE_ANTWORT, NUMMERIERT, ANTWORT_FOLGT, FRAGE_ANTWORT_FOLGT, RULE_SETS, groupedAnswerNumbers, splitAtQuestionMark, MIN_NUMBER_DENSITY, MIN_INFERRED_ANSWER_RATE, LARGE_QUESTION_LIST, MIN_ANSWER_RATE_LARGE, QaSegment, SegmentationResult, normaliseNumber, expandNumbers, MAX_NUMBER_SKIP, splitAtAnswerDivider, SegmentOptions, restatesSameQuestion, applyRules, checkSegments, segmentQa, FetchedDocument, SourceMetadata, ExtractRequest, ExtractResult, Abstentions, extract, ValidatorProblem, EARLIEST_PLAUSIBLE_YEAR, latestPlausibleYear, validateExtractedRecord
```

## Depends on

- `lib-models` — the canonical record schema, validators and the parliament table
- `lib-pdf` — the PDF reader
- `lib-perceive` — the Perceiver seam (OCR)
- `lib-repro` — canonical JSON, hashing and the extractor version stamp

## Tests

`test/extract.test.ts` — run with:

```bash
npm test -w @maschinenlesbar.org/openka-lib-extract
```
