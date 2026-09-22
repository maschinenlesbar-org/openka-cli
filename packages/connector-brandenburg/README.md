# @maschinenlesbar.org/openka-connector-brandenburg

> Landtag Brandenburg — reachable today, no adapter of its own yet.

This package exists so the gap is a **place** rather than an absence.
Landtag Brandenburg delivers
to the Parlamentsspiegel, so it can be synced now through the shared aggregator —
metadata and PDF links, with no Land-specific handling of where its documents
actually live. `ka sources list` reports it as `via_aggregator`, which is the honest
state.

| | |
|---|---|
| parliament key | `brandenburg` |
| Herkunft code | `BRA` — how the Parlamentsspiegel export format identifies this Land |
| instrument | Kleine Anfrage |
| `document_type` | `kleine_anfrage` |

**Researched 2026-09-22 — off limits, and not for technical reasons.**

Brandenburg's own Parlamentsdokumentation is at
`www.parlamentsdokumentation.brandenburg.de`, and it serves a stateless Perl CGI
(`/cgi-bin/pardok-cache.pl?id=…`) that would have been the simplest interface of any
Land here.

Its `robots.txt` is:

```
User-agent: *
Disallow: /
```

The whole site, for every client. So this Land stays on the Parlamentsspiegel, the
same decision as Sachsen-Anhalt's PADOKA. Respecting robots.txt is a design
principle here (CONCEPT.md §7), not a preference, and it applies most when the
alternative would have been easy.

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
