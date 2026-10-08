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

**Two numbers, kept apart.** Sachsen-Anhalt numbers a Kleine Anfrage on its own
(`KA 8/4011`) and its Drucksachen on their own (`8/4011`), and the two sequences
overlap. An unanswered question is listed as "Kleine Anfrage ohne Antwort … Kleine
Anfrage 8/4011" and is stored under the reference `KA 8/4011`, id
`sachsen-anhalt-8-ka-4011`. Until 2026-10-08 it was read as Drucksache 8/4011, and in a
corpus synced before then it may have taken that number's id and replaced an older
answer under it (issue #22). A question stored the old way is removed when it is seen
again under its KA number, but only when the old record holds the same documents.
`ka reextract` moves the rest (issue #25). Such a record has a question date and no answer
date, which no Drucksache here has, and that is how `currentReference` (lib-models) tells
it apart. `ka doctor` names one that is left, and a sync refuses to overwrite it.

**The answer takes over its question.** The answer is a Drucksache and cites its
question ("(KA 8/3417)"). When it arrives, it takes the stored question's date, and the
question-only record `KA 8/3417` is removed. The sync warns for each.

**No question date, as a rule.** Question and answer are one Drucksache, dated by the
answer. The Parlamentsspiegel row does not name the question's date: two dates in a
Fundstelle are the paper's and its Nachtrag's. About 1.5% of the papers print it, on the
page after the cover ("Kleine Anfrage - KA 8/3417 vom 20.11.2025"), and `readKaDate`
(lib-extract) reads it there. It is taken only when it belongs to the paper's own KA
number and is not later than the answer. Otherwise
`dates.submitted` is a known gap of the parliament (`knownGaps`, lib-models): records
missing only it stay out of `ka review`, and `--since/--until` apply to the answer's
date here.

**And when it does fetch, it goes slowly.** `minHostIntervalMs` is 4000 — eight times
the default. A server that asked not to be crawled at all should not then be hit at
the usual rate. `minHostIntervalReason` says why, in `ka sources show` and in a note
before a sync's first request; a lower `--min-host-interval` does not lower the floor,
and the sync says so.

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
