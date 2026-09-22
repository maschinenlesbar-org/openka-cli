# @maschinenlesbar.org/openka-connector-bayern

> The Landtag's own Anfragen feed, plus the static Drucksachen it files them under.

Bayern publishes RSS feeds at `/parlament/dokumente/rss-feeds/`; the one used here is
`art=ANFRAGE`, "Drucksachen von Anfragen". robots.txt disallows `/service/suche` (the
site search) and `/webangebot2/Vorgangsmappe` (the **old** Vorgangsmappe) — the feed
and the documents below are on neither path.

Three things had to be measured, and each one changed the design.

**The feed mixes two instruments.** `art=ANFRAGE` carries both Schriftliche Anfragen —
Bayern's instrument for this corpus — and Anfragen zum Plenum, the oral questions for
a plenary sitting. Nothing in an item says which: every title reads
"Initiativdrucksache 19/13327".

**Anfragen zum Plenum are Sammeldrucksachen.** One Drucksache collects ~50 separate
questions, each a feed item with its own `gegenstandid` and subject but the *same*
Drucksachennummer. In the window checked, 602 items carried only 444 distinct
references, and three of them accounted for 161 items. Since a record's id derives
from its reference, fifty of those would collide into one record.

**The feed's link is not the document.** `vorgangsmappe.xhtml?gegenstandid=…` returns
a Vorgangsmappe: a dossier generated on demand, carrying a `Stand:` timestamp, so two
fetches of the same Anfrage differ in their bytes. For a Sammeldrucksache it is the
whole 81-page collection, with only the header line naming the requested question. A
corpus built on byte-exact reproducibility should not archive that.

All three are solved by one observation — **Bayern files its Drucksachen at a static
path that names the instrument**:

```
…/ElanTextAblage_WP19/Drucksachen/Schriftliche Anfragen/19_0013327.pdf
```

A 200 there is proof the paper is a Schriftliche Anfrage; a 404 is proof it is not.
So the type test is a `HEAD` against a constructed URL rather than a guess about the
feed's shape, and what gets archived is the Landtag's own stable file. Verified
against both instruments: four Schriftliche Anfragen answer 200, all three
Sammeldrucksachen answer 404.

That file is a **combined paper** — question and "Antwort des Staatsministeriums …"
in one document — which our PDF reader parses with no problems reported.

**No dates are claimed from the feed.** `pubDate` is when the entry appeared, not when
the Anfrage was submitted or answered; the document header carries both and the
extractor reads them there.

The cost worth knowing: one `HEAD` per distinct Drucksachennummer in the window. That
is the price of not guessing, and `lib-http`'s `head()` exists for it.

## Public surface

Everything is re-exported from the package root:

```
PARLIAMENT, LABEL, LANDTAG_BAYERN, ANFRAGEN_FEED, BAYERN_LATEST_PERIOD, drucksacheUrl, FeedItem, parseFeed, byReference, BayernFeedSource, toRef, createSource, ENTRY
```

## Depends on

- `lib-parlamentsspiegel` — the shared aggregator adapter
- `lib-source` — the `Source` protocol and the scraping helpers

## Tests

`test/bayern.test.ts` — run with:

```bash
npm test -w @maschinenlesbar.org/openka-connector-bayern
```

## Fixtures

**Goldens** — frozen input→record pairs, verified by `ka-factory goldens verify`:

- `fixtures/bayern/bayern-19-6524/` — the record, its metadata and the exact source bytes

**Recorded upstream payloads**, so tests never touch a live parliament:

- `fixtures/payloads/rss-anfragen.xml`
