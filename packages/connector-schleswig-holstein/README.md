# @maschinenlesbar.org/openka-connector-schleswig-holstein

> Schleswig-Holsteinischer Landtag — reachable today, no adapter of its own yet.

This package exists so the gap is a **place** rather than an absence.
Schleswig-Holsteinischer Landtag delivers
to the Parlamentsspiegel, so it can be synced now through the shared aggregator —
metadata and PDF links, with no Land-specific handling of where its documents
actually live. `ka sources list` reports it as `via_aggregator`, which is the honest
state.

| | |
|---|---|
| parliament key | `schleswig-holstein` |
| Herkunft code | `SH` — how the Parlamentsspiegel export format identifies this Land |
| instrument | Kleine Anfrage |
| `document_type` | `kleine_anfrage` |

**Schleswig-Holstein files question and answer as one document**, so its result row lists no follow-up and names the answering minister in the same `Urheber` field as the asker. Reading that field as a list of people produced an invented political party out of half a ministry's name; `lib-source`'s `parseUrheber` now separates offices and Fraktionen from people, and the answering body becomes `answered_by.ministry`. The two goldens here were frozen before that fix and still carry the old askers as input.

It does have **goldens** here: records produced through the aggregator, frozen and verified by `ka-factory goldens verify` like any other. A Land needing no adapter of its own is not the same as a Land nobody has read.

**Researched 2026-09-22 — same software as Rheinland-Pfalz, same obstacle.**

Schleswig-Holstein runs e-LISSH, and Bremen's PARiS templates are literally named
`LISSH.web`, which is why this Land looked cheap. It is not:

- The **classic STARWEB servlet** answers 503 on every path tried
  (`e-lissh.landtag.ltsh.de/starweb/lissh/servlet.starweb`, and the variants).
- `e-lissh.landtag.ltsh.de/` redirects to `/portal/browse.tt.html` — the same
  client-side "ESearch" application Rheinland-Pfalz serves, which renders its results
  in the browser rather than on the server.
- The root carries `<meta name="robots" content="noindex,nofollow">`. That is aimed at
  search engines rather than at a user-invoked client, but it is a clear signal and
  worth weighing before building anything that fetches in bulk.

So `lib-starweb` does not apply here either. An adapter needs the ESearch client that
Rheinland-Pfalz also needs; doing it once would cover both Länder.

**Schleswig-Holstein has goldens here already**, produced through the aggregator.
Note that its combined row names the answering minister in the same `Urheber` field as
the asker — see `lib-source`'s `parseUrheber`, which keeps offices out of `askers`.

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

- `fixtures/schleswig-holstein/schleswig-holstein-20-2905/` — the record, its metadata and the exact source bytes
- `fixtures/schleswig-holstein/schleswig-holstein-20-3153/` — the record, its metadata and the exact source bytes
