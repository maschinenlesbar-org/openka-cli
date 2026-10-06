# @maschinenlesbar.org/openka-lib-registry

> Every parliament OpenKA covers, and the honest state of its adapter.

All 17 are listed, including the ten with no adapter of their own. That is
deliberate: `ka sources list` should show the whole map with the gaps visible,
because a silent absence looks exactly like a source that found nothing, and the
difference matters to anyone deciding whether the corpus can answer their question.

This package only **collects**. Each connector declares its own `ENTRY` — key,
label, status, note and how to build it — so a Land's description lives with the
Land's code. Adding a parliament means adding a package and one line here.

Its test is also where every connector's "am I registered?" assertion lives. A
connector cannot check that itself: the registry depends on it, and the arrow cannot
point both ways.

## Public surface

Everything is re-exported from the package root:

```
SOURCE_REGISTRY, sourceEntry, sourceKeys, adapterSourceKeys, sourceKeyProblem, createSource
```

`adapterSourceKeys()` lists the sources with an adapter of their own, implemented and
pinned to one parliament — what `ka sync --all` runs. The Parlamentsspiegel aggregator
is left out: it files records under the ids of the Länder it covers and would overwrite
their own adapters' records.

`createSource(key)` checks the key first (`sourceKeyProblem`): a blank or unknown
key throws `OpenKaValidationError` ("Invalid source: Unknown source …", listing every
key), which `ka sync --source` prints as its usage error. Keys match exactly.

## Depends on

- `connector-baden-wuerttemberg` — the baden-wuerttemberg connector
- `connector-bayern` — the bayern connector
- `connector-berlin` — the berlin connector
- `connector-brandenburg` — the brandenburg connector
- `connector-bremen` — the bremen connector
- `connector-bund` — the bund connector
- `connector-hamburg` — the hamburg connector
- `connector-hessen` — the hessen connector
- `connector-mecklenburg-vorpommern` — the mecklenburg-vorpommern connector
- `connector-niedersachsen` — the niedersachsen connector
- `connector-nordrhein-westfalen` — the nordrhein-westfalen connector
- `connector-rheinland-pfalz` — the rheinland-pfalz connector
- `connector-saarland` — the saarland connector
- `connector-sachsen` — the sachsen connector
- `connector-sachsen-anhalt` — the sachsen-anhalt connector
- `connector-schleswig-holstein` — the schleswig-holstein connector
- `connector-thueringen` — the thueringen connector
- `lib-errors` — the shared error hierarchy
- `lib-parlamentsspiegel` — the shared aggregator adapter
- `lib-source` — the `Source` protocol and the scraping helpers

## Tests

`test/registry.test.ts` — run with:

```bash
npm test -w @maschinenlesbar.org/openka-lib-registry
```
