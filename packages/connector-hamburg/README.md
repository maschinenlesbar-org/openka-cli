# @maschinenlesbar.org/openka-connector-hamburg

> Hamburgische Bürgerschaft — reachable today, no adapter of its own yet.

This package exists so the gap is a **place** rather than an absence.
Hamburgische Bürgerschaft delivers
to the Parlamentsspiegel, so it can be synced now through the shared aggregator —
metadata and PDF links, with no Land-specific handling of where its documents
actually live. `ka sources list` reports it as `via_aggregator`, which is the honest
state.

| | |
|---|---|
| parliament key | `hamburg` |
| Herkunft code | `HH` — how the Parlamentsspiegel export format identifies this Land |
| instrument | Schriftliche Kleine Anfrage |
| `document_type` | `kleine_anfrage` |

Hamburg calls its instrument a **Schriftliche Kleine Anfrage**; it maps to `kleine_anfrage`.

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
