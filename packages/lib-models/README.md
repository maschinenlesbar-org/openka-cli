# @maschinenlesbar.org/openka-lib-models

> The canonical record — the standardized format at the heart of the project.

The TypeScript types in `schema.ts` are the source of truth. The JSON Schema is
written by hand against them and pinned by a test that compares it to a real record,
so the two cannot drift apart unnoticed.

Two properties carry the project's trust guarantee: `extraction` records exactly how
to reproduce a fact — extractor version, model artifact hashes, input hash — and
`abstained_fields` names every hole rather than letting a missing value look like an
absent one.

Validation never repairs. It reports, and the caller abstains. A corrected date is a
fact nobody checked, which is precisely what this project exists not to produce.

`parliaments.ts` is the table of all 17 parliaments: the stable key used in record
ids, the German label, the Herkunft code the Parlamentsspiegel export format uses,
the instrument each parliament calls its questions, and the `document_type` that
maps to.

## What is in here

- **`src/json-schema.ts`** — JSON Schema for the canonical record, for consumers outside TypeScript.
- **`src/parliaments.ts`** — The 17 parliaments OpenKA covers: the Bundestag plus the 16 Landtage.
- **`src/reference.ts`** — A Drucksachennummer, as a value rather than a string.
- **`src/schema.ts`** — The canonical OpenKA record — the standardized format that is the heart of the project (CONCEPT.md §3).
- **`src/validate.ts`** — Deterministic structural validation of a canonical record.

## Public surface

Everything is re-exported from the package root:

```
RECORD_JSON_SCHEMA, ParliamentKeys, ParliamentKey, Parliament, PARLIAMENTS, parliamentByKey, parliamentByHerkunft, isParliamentKey, Reference, periodNumber, parseReference, formatReference, referenceSlug, SCHEMA_VERSION, DocumentTypes, DocumentType, Tiers, Tier, ReviewStatuses, ReviewStatus, SourceDocumentRoles, SourceDocumentRole, Asker, AnsweredBy, Dates, QaPair, Markers, SourceDocument, ModelArtifact, Extraction, KaRecord, makeRecordId, ValidationIssue, isCalendarDate, validateRecord, assertValidRecord
```

## Depends on

- `lib-repro` — canonical JSON, hashing and the extractor version stamp

## Tests

`test/models.test.ts` — run with:

```bash
npm test -w @maschinenlesbar.org/openka-lib-models
```
