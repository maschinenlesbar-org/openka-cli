# @maschinenlesbar.org/openka-connector-bremen

> The Bürgerschaft's own PARiS, with the aggregator only behind it.

PARiS is a STARWEB installation — see `lib-starweb` for the session handshake it
needs. What is Bremen-specific is what a result line says and where the documents
live.

**The type lives in `Dokumenttyp`, not in `Vorgangstyp`.** Searching
`06_LISSH_VTYP=Kleine Anfrage` returns nothing at all, with no error; the field that
works is `07_LISSH_DTYP`. This had to be measured rather than reasoned about,
because a wrong field here is indistinguishable from a Land that published nothing.

**The Bürgerschaft is two chambers**, and the marker sits inside the result line:

```
Drs 21/1983 ,   Kleine Anfrage vom 10.09.2026 BIW    <- Land
Drs 21/905 S ,  Kleine Anfrage vom 09.09.2026 BIW    <- Stadt
```

Only the Land chamber's Kleine Anfragen are questions to a Landesregierung in the
sense this corpus means. The `S` is **captured**, not left to break the match: a
Stadtbürgerschaft paper that fails to parse looks exactly like a changed template,
and the adapter should be able to say which it is. In the recorded window, 8 of 11
records are Land and 3 are Stadt.

**Bremen's result line names the Fraktion, not the members.** So `askers` is empty
rather than carrying a person called "BIW" — the members are left to the document.
That is the same rule that keeps a ministry out of the asker list elsewhere.

**The PDF is linked directly** on `www.bremische-buergerschaft.de`. That host's
robots.txt disallows a handful of named crawlers — BLEXBot, MJ12bot, AhrefsBot,
GPTBot — and nothing else; `User-agent: *` is unrestricted. This tool is not a
crawler: it fetches documents a person asked for, at the rate limit the engine
imposes.

**An earlier note here said Bremen has no Kleine Anfragen in the Parlamentsspiegel.**
That remains true of the aggregator, and it is why going to the Land's own system
mattered more here than anywhere else: PARiS has them.

## Public surface

Everything is re-exported from the package root:

```
PARLIAMENT, LABEL, PARIS, BREMEN_LATEST_PERIOD, FIELD, BremenRecordLine, parseRecordLine, parseTitle, BremenParisSource, toRef, askersOf, createSource, ENTRY
```

## Depends on

- `lib-extract` — the deterministic tier stack
- `lib-models` — the canonical record schema, validators and the parliament table
- `lib-parlamentsspiegel` — the shared aggregator adapter
- `lib-source` — the `Source` protocol and the scraping helpers
- `lib-starweb` — 

## Tests

`test/bremen.test.ts` — run with:

```bash
npm test -w @maschinenlesbar.org/openka-connector-bremen
```

## Fixtures

**Recorded upstream payloads**, so tests never touch a live parliament:

- `fixtures/payloads/paris-results.html`
- `fixtures/payloads/paris-search-form.html`
