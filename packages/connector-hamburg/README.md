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

**Researched 2026-09-22 — the service was down, and that is all that is wrong.**

Hamburg runs ParlDok at `www.buergerschaft-hh.de/parldok/`, which means
`lib-parldok` — the client Thüringen and Mecklenburg-Vorpommern already use — very
likely covers it. It could not be confirmed, because the backend is failing:

| request | result |
|---|---|
| `/parldok/` | connects, TLS completes, then **empty reply** (curl exit 52) |
| `/nonexistent-xyz/` | a clean **404** |
| `/` | 403, the stock IIS message |

The 404 on an arbitrary path is what matters: the site answers this client normally,
so the empty reply on `/parldok/` is the ParlDok application failing rather than a
block. `parldok.buergerschaft-hh.de` does not resolve, so there is no alternative
host to try, and `www.buergerschaft-hh.de/robots.txt` is a 404 — nothing is
disallowed.

**This is the cheapest Land left.** When the service is back, the work is a facet
listing to find Hamburg's id for "Schriftliche Kleine Anfrage" and a recorded window,
the same two steps Mecklenburg-Vorpommern took.

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
