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
produces **nothing**, with a warning saying why and naming the flag. `ka sync` prints
`sachsen-anhalt: blocked — nothing was looked at` (and `"blocked"` with the reason in `--json`),
exits 0, and does not record the run as a sync — so a scheduled job can tell "blocked"
from "nothing new".

**Why nothing rather than metadata-only records.** A record with no document abstains
on everything it exists to carry — no full text, no question, no answer. A corpus of
those is worse than an honest gap.

**The override is the operator's.** `ka sync --source sachsen-anhalt --ignore-robots` fetches
anyway. It is never inferred and never silent: the run warns, once per host, that the
flag was used and that the decision was the operator's — on stderr, and in `warnings`
with `--json`. The records themselves do not carry it (their schema has no place for
it), so a corpus passed on does not show which documents were fetched under the
override: keep the sync's output if that matters.

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

Deleting the second group would not open the documents, though: they live under
`/files/` (the Parlamentsspiegel links them as `/files/drs/wp8/dkl_anfr/k4012ckl.pdf`),
which the *first* group already disallows. That is why the gate asks robots.txt about
a document path (`DOCUMENT_PATH`, `/files/drs/`) and not about the search servlet:
asking about a path no document is served from let discovery run under a file that
blocked every document, and stored records with no document at all.

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
