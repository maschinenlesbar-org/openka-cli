# @maschinenlesbar.org/openka-connector-mecklenburg-vorpommern

> The Landtag's own Parlamentsdokumentation, with the aggregator only behind it.

MV runs **Parldok** — the same software as Thüringen — so the client is shared
(`lib-parldok`) and only the hosts differ.

It publishes the question and the answer as **one** Drucksache, filed under the
Dokumenttyp "Kleine Anfrage und Antwort": 14,431 of them as of 2026, against 4,149
filed as "Kleine Anfrage" alone. The combined paper is what this adapter discovers,
so a record needs exactly one document and its role is `combined_pdf`. The
unanswered ones are deliberately not discovered — a record built from one would have
no answer, and the combined paper supersedes it a few weeks later.

Three things make this a better source than the Parlamentsspiegel, which is why it
is the primary:

- the result row carries the **answering ministry**, the asker and their Fraktion as
  structured fields, rather than as a sentence to be parsed out of prose;
- `/parldok/dokument/<id>` **serves the PDF directly** — no viewer, no HTML wrapper,
  no constructed URL;
- the **date window is a server-side filter**, so a sync fetches the window it asked
  for instead of everything and discarding.

`createSource()` returns the Parldok source with `ParlamentsspiegelSource` behind it.
The aggregator is reached only if the API throws or answers in a shape the client
does not recognise — never because a window came back empty.

**The author field needs care.** `authorhtml` reads
`"Beate Schlupp (CDU), Landesregierung (Ministerium für Klimaschutz, Landwirtschaft,
ländliche Räume und Umwelt)"` — the members who asked *and* the government that
answered, and three of those four commas belong to the ministry. `splitAuthors`
splits only on commas outside parentheses, and `parseAuthors` keeps the government
out of `askers`. Reading it as a list of people is exactly what produced an invented
political party out of half a ministry's name in Schleswig-Holstein.

**robots.txt**: `https://www.dokumentation.landtag-mv.de/robots.txt` is a 404, so
nothing here is disallowed. The requests this makes are the ones the site's own
search page makes.

## Public surface

Everything is re-exported from the package root:

```
PARLIAMENT, LABEL, PARLDOK, TYPE_KLEINE_ANFRAGE_UND_ANTWORT, MV_LATEST_PERIOD, splitAuthors, ParsedAuthors, parseAuthors, MecklenburgVorpommernParldokSource, toRef, createSource, ENTRY
```

## Depends on

- `lib-extract` — the deterministic tier stack
- `lib-models` — the canonical record schema, validators and the parliament table
- `lib-parlamentsspiegel` — the shared aggregator adapter
- `lib-parldok` — 
- `lib-source` — the `Source` protocol and the scraping helpers

## Tests

`test/mecklenburg-vorpommern.test.ts` — run with:

```bash
npm test -w @maschinenlesbar.org/openka-connector-mecklenburg-vorpommern
```

## Fixtures

**Recorded upstream payloads**, so tests never touch a live parliament:

- `fixtures/payloads/parldok-search.json`
