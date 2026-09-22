# @maschinenlesbar.org/openka-connector-bayern

> Bayerischer Landtag — reachable today, no adapter of its own yet.

This package exists so the gap is a **place** rather than an absence.
Bayerischer Landtag delivers
to the Parlamentsspiegel, so it can be synced now through the shared aggregator —
metadata and PDF links, with no Land-specific handling of where its documents
actually live. `ka sources list` reports it as `via_aggregator`, which is the honest
state.

| | |
|---|---|
| parliament key | `bayern` |
| Herkunft code | `BAY` — how the Parlamentsspiegel export format identifies this Land |
| instrument | Schriftliche Anfrage |
| `document_type` | `schriftliche_anfrage` |

Bayern's instrument is the **Schriftliche Anfrage**, not the Kleine Anfrage, and the record's `document_type` says so.

It does have **goldens** here: records produced through the aggregator, frozen and verified by `ka-factory goldens verify` like any other. A Land needing no adapter of its own is not the same as a Land nobody has read.

**Writing the adapter.** Implement `Source` in `src/index.ts`, change this package's `ENTRY` to `status: "implemented"` and a factory, and put its tests and recorded
payloads in this folder. Nothing else in the workspace has to change: the registry
already imports this package. Look at `connector-sachsen` for a Land whose documents
sit behind a viewer, `connector-saarland` for one behind an HTML wrapper, and
`connector-berlin` for one with a real data feed.

## Public surface

Everything is re-exported from the package root:

```
PARLIAMENT, LABEL, STATUS, NOTE, createSource, ENTRY
```

## Depends on

- `lib-parlamentsspiegel` — the shared aggregator adapter
- `lib-source` — the `Source` protocol and the scraping helpers

## Tests

No tests yet — there is no Land-specific code to test. Discovery through the aggregator is covered in `lib-parlamentsspiegel`.

## Fixtures

**Goldens** — frozen input→record pairs, verified by `ka-factory goldens verify`:

- `fixtures/bayern/bayern-19-6524/` — the record, its metadata and the exact source bytes
