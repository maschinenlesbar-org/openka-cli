# @maschinenlesbar.org/openka-connector-niedersachsen

> The Land where the answer is a different Drucksache and nothing links the two.

The Landtag republishes an answered Anfrage under a **new** number as a combined
paper — "Kleine Anfrage zur schriftlichen Beantwortung … mit Antwort der
Landesregierung" — and that paper names the original in its header (`Drs. 19/7745`).
The link is recoverable, but only by reading the answer, which means reading every
candidate Drucksache. That is a build-time sweep, not something a sync should do, so
`ka-factory answers niedersachsen` builds a question→answer map and freezes it as a
corpus artifact; this adapter consumes it.

The Parlamentsspiegel row **does** list the answer as a follow-up document — this
package's notes used to say it did not, which was an artefact of the aggregator
parser. Since that was fixed, a corpus without the frozen map is not answer-less; it
just lacks the confirmation the sweep provides by actually reading the paper. Where
the map has an entry it is authoritative and **replaces** the row's follow-up rather
than adding to it, because they are the same paper and appending would fetch and
extract it twice.

Every Drucksache sits at a predictable URL — the outer folder is the number rounded
up to a multiple of 2500, the inner one its 500-wide block, verified across both
boundaries — which is what makes the sweep possible at all.

## Public surface

Everything is re-exported from the package root:

```
LANDTAG_NDS, ANSWER_INDEX, AnswerEntry, SweptRange, AnswerIndex, mergeRanges, isCovered, niedersachsenUrl, numberOf, isAnsweredEdition, citedQuestion, NiedersachsenSource, ENTRY
```

## Depends on

- `lib-models` — the canonical record schema, validators and the parliament table
- `lib-parlamentsspiegel` — the shared aggregator adapter
- `lib-source` — the `Source` protocol and the scraping helpers

## Tests

`test/niedersachsen.test.ts` — run with:

```bash
npm test -w @maschinenlesbar.org/openka-connector-niedersachsen
```

## Fixtures

**Goldens** — frozen input→record pairs, verified by `ka-factory goldens verify`:

- `fixtures/niedersachsen/niedersachsen-19-7659/` — the record, its metadata and the exact source bytes
