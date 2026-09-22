# @maschinenlesbar.org/openka-connector-sachsen-anhalt

> Public documents, a malformed robots.txt, and the operator's call.

**The documents are public. The robots.txt is the only thing in the way.**

They are also free of copyright as amtliche Werke (§ 5 UrhG), served unauthenticated,
and already listed — with reference, title and dates — through the Parlamentsspiegel,
which this Land delivers to itself and which is unrestricted.

What is restricted is the **document server**, `padoka.landtag.sachsen-anhalt.de`:

```
User-agent: *
Disallow: /
```

So this connector discovers through the aggregator and then asks that server's own
robots.txt whether its documents may be fetched. By default the answer is no, and it
produces **nothing**, with a warning saying why and naming the flag.

**Why nothing rather than metadata-only records.** A record with no document abstains
on everything it exists to carry — no full text, no question, no answer. A corpus of
those is worse than an honest gap.

**The override is the operator's.** `ka sync --source sachsen-anhalt --ignore-robots` fetches
anyway. It is never inferred and never silent: every record carries a warning saying
the flag was used and that the decision was the operator's.

**And when it does fetch, it goes slowly.** `minHostIntervalMs` is 4000 — eight times
the default. A server that asked not to be crawled at all should not then be hit at
the usual rate.

**The check is live.** robots.txt is read at run time, so if the Landtag lifts the
rule this connector starts working with no release and no code change. There is a
test for exactly that.

**Specific to Sachsen-Anhalt.** PADOKA is a STARWEB installation, so `lib-starweb`
would very likely reach it if the file allowed.

And that file is **malformed**: two separate `User-agent: *` groups, the first
disallowing only `/files/`, the last disallowing everything.

```
User-agent: *
Disallow: /files/
User-agent: SemrushBot
Disallow: /
...
User-agent: *
Disallow: /
```

RFC 9309 applies the rules of every matching group, so the correct reading is a
whole-site block, and that is the reading taken here. But two contradictory groups
for the same agent look far more like an editing accident than a policy — which
makes this one worth asking the Landtag about rather than reinterpreting.

## Public surface

Everything is re-exported from the package root:

```
PARLIAMENT, LABEL, DOCUMENT_ORIGIN, DOCUMENT_PATH, POLITE_INTERVAL_MS, SachsenAnhaltSource, createSource, ENTRY
```

## Depends on

- `lib-parlamentsspiegel` — the shared aggregator adapter
- `lib-source` — the `Source` protocol and the scraping helpers

## Tests

`test/sachsen-anhalt.test.ts` — run with:

```bash
npm test -w @maschinenlesbar.org/openka-connector-sachsen-anhalt
```
