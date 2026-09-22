# @maschinenlesbar.org/openka-connector-baden-wuerttemberg

> Landtag Baden-Württemberg — reachable today, no adapter of its own yet.

This package exists so the gap is a **place** rather than an absence.
Landtag Baden-Württemberg delivers
to the Parlamentsspiegel, so it can be synced now through the shared aggregator —
metadata and PDF links, with no Land-specific handling of where its documents
actually live. `ka sources list` reports it as `via_aggregator`, which is the honest
state.

| | |
|---|---|
| parliament key | `baden-wuerttemberg` |
| Herkunft code | `BW` — how the Parlamentsspiegel export format identifies this Land |
| instrument | Kleine Anfrage |
| `document_type` | `kleine_anfrage` |

It does have **goldens** here: records produced through the aggregator, frozen and verified by `ka-factory goldens verify` like any other. A Land needing no adapter of its own is not the same as a Land nobody has read.

**Researched 2026-09-22 — PARLIS, and the most promising of the three ESearch Länder.**

Baden-Württemberg's own system is **PARLIS**, at `https://parlis.landtag-bw.de/parlis/`.
`parlis.landtag-bw.de/robots.txt` is a 404, so nothing is disallowed.

It is an **ESearch** portal — the same software Rheinland-Pfalz (OPAL) and
Schleswig-Holstein (e-LISSH) run, which makes `lib-esearch` a three-Land multiplier
rather than two. And BW looks like the way in: its search page is 196 kB with 20
forms, where Rheinland-Pfalz serves a 4.5 MB client-side shell that renders every
query identically. That suggests PARLIS still answers server-side.

Note that the Landtag's own Parlamentsdokumentation page links to **both** PARLIS and
the Parlamentsspiegel, describing the latter as the joint information system of the
Länder parliaments. So the aggregator is endorsed here rather than merely tolerated —
but PARLIS is the Land's own, and that is what this connector should use.

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

- `fixtures/baden-wuerttemberg/baden-wuerttemberg-17-8906/` — the record, its metadata and the exact source bytes
