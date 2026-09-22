# @maschinenlesbar.org/openka-connector-brandenburg

> Public documents, a blanket robots.txt, and the operator's call.

**The documents are public. The robots.txt is the only thing in the way.**

They are also free of copyright as amtliche Werke (§ 5 UrhG), served unauthenticated,
and already listed — with reference, title and dates — through the Parlamentsspiegel,
which this Land delivers to itself and which is unrestricted.

What is restricted is the **document server**, `www.parlamentsdokumentation.brandenburg.de`:

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

**The override is the operator's.** `ka sync --source brandenburg --ignore-robots` fetches
anyway. It is never inferred and never silent: every record carries a warning saying
the flag was used and that the decision was the operator's.

**And when it does fetch, it goes slowly.** `minHostIntervalMs` is 4000 — eight times
the default. A server that asked not to be crawled at all should not then be hit at
the usual rate.

**The check is live.** robots.txt is read at run time, so if the Landtag lifts the
rule this connector starts working with no release and no code change. There is a
test for exactly that.

**Specific to Brandenburg.** Its Parlamentsdokumentation serves a stateless Perl CGI
(`/cgi-bin/pardok-cache.pl?id=…`) which would have been the simplest interface of any
Land here. And Brandenburg's constitution carries a right to Akteneinsicht
(Art. 21(4) LV), which sits oddly beside a blanket `Disallow`. That is an argument to
put to the Landtag — not a licence to ignore the file.

## Public surface

Everything is re-exported from the package root:

```
PARLIAMENT, LABEL, DOCUMENT_ORIGIN, DOCUMENT_PATH, POLITE_INTERVAL_MS, BrandenburgSource, createSource, ENTRY
```

## Depends on

- `lib-parlamentsspiegel` — the shared aggregator adapter
- `lib-source` — the `Source` protocol and the scraping helpers

## Tests

`test/brandenburg.test.ts` — run with:

```bash
npm test -w @maschinenlesbar.org/openka-connector-brandenburg
```
