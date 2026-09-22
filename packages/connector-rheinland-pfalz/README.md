# @maschinenlesbar.org/openka-connector-rheinland-pfalz

> Landtag Rheinland-Pfalz — reachable today, no adapter of its own yet.

This package exists so the gap is a **place** rather than an absence.
Landtag Rheinland-Pfalz delivers
to the Parlamentsspiegel, so it can be synced now through the shared aggregator —
metadata and PDF links, with no Land-specific handling of where its documents
actually live. `ka sources list` reports it as `via_aggregator`, which is the honest
state.

| | |
|---|---|
| parliament key | `rheinland-pfalz` |
| Herkunft code | `RPF` — how the Parlamentsspiegel export format identifies this Land |
| instrument | Kleine Anfrage |
| `document_type` | `kleine_anfrage` |

**Researched 2026-09-22 — this Land is harder than it looked, and the Landtag says so.**

Rheinland-Pfalz runs OPAL. There are two interfaces and neither is usable today:

- The **classic STARWEB servlet** (`opal.rlp.de/starweb/OPAL/servlet.starweb`) is
  retired. It answers 200 with an error page: *"Es ist ein Fehler aufgetreten. Bitte
  wenden sie sich an den Support. Sie finden unsere Dokumente auch beim
  Parlamentsspiegel unter www.parlamentsspiegel.de."* The Landtag itself points
  machine users at the aggregator.
- The **new portal** (`opal.rlp.de/portal/browse.tt.html`) is a 4.5 MB client-side
  "ESearch" application. Every query — `?type=professional&q=…` included — returns
  the identical shell with unrendered `${item_count}` placeholders, so the records
  come from an XHR layer that would have to be reverse-engineered.

So `lib-starweb` does **not** apply here, despite OPAL being STARWEB underneath. An
adapter needs a third client for the ESearch portal, shared with Schleswig-Holstein,
which runs the same software.

Until then the Parlamentsspiegel is not a fallback here — it is the route the Landtag
recommends.

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
