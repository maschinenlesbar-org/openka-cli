# Data licensing

**We provide the tool, not the data.** This package is code. Everything it fetches
belongs to the parliament that published it, under that parliament's terms — and
those terms are *not* uniform. Check the source you are using before you republish
anything.

What follows is a summary for orientation, not legal advice, and not a substitute
for reading the upstream terms yourself.

## Deutscher Bundestag — DIP

- Portal: <https://dip.bundestag.de/> · API: <https://search.dip.bundestag.de/api/v1>
- Access needs an API key. The Bundestag publishes a shared public key on
  <https://dip.bundestag.de/über-dip/hilfe/api> and issues personal keys on request
  from `parlamentsdokumentation@bundestag.de`. **No key is bundled with this
  package.** Using the public key means accepting the Bundestag's terms of use for
  it, including its rate limits.
- Parliamentary papers (Drucksachen, Plenarprotokolle) are official works. Under
  §5 UrhG official works are not protected by copyright, but §62 UrhG's prohibition
  on alteration applies — quote them as published.

## Abgeordnetenhaus von Berlin — PARDOK open data

- Portal: <https://www.parlament-berlin.de/dokumente/open-data>
- The metadata export is published as open data by the Abgeordnetenhaus. The
  documents themselves are official works (§5 UrhG), served from
  `pardok.parlament-berlin.de`.
- The export is rebuilt daily and is one file per Wahlperiode. It is 50+ MB; this
  client uses ETag / If-Modified-Since so a daily sync costs one 304.

## Parlamentsspiegel — the Länder's shared portal

- Portal: <https://www.parlamentsspiegel.de/>
- Run by the Landtag NRW for the presidents of all 16 Landtage.
- **It publishes no API**, and its own help text states that it stores no documents
  and therefore offers no download interface — it links to the owning Landtag.
  Enquiries: `Parlamentsspiegel@landtag.nrw.de`, +49 211 884 2443.
- This client reads its public search results and follows the links to the Länder's
  own servers. The documents are each Land's, under that Land's terms.

## The 16 Länder

Terms vary by Land and this project does not assume they are uniform. Two specifics
worth knowing, because they change what a record can promise:

- **Sachsen** serves document links that expire after about fifteen minutes. Records
  pointing at one carry `url_stable: false`, and the archived blob in the corpus is
  then the only retrievable copy.
- Several Länder publish only scanned PDFs with no text layer. Those documents reach
  the `ocr` tier, and in strict mode (the default) they abstain rather than being
  guessed at.

## What this package archives, and why

Every fetched document is stored byte-for-byte under its own sha256. That is not
incidental: the raw PDF is the appeal court for any extracted field, and it is what
`ka verify` re-runs an extraction against. A corpus you build is a copy of other
people's published documents — redistributing it is your decision and your
responsibility under the terms above.

## Being a good citizen

The client sends an identifiable User-Agent with a contact URL, rate-limits itself
per host, makes conditional requests, and never re-fetches a document whose bytes it
already holds. Please do not raise the limits to scrape harder; if you need bulk
data, ask the parliament.
