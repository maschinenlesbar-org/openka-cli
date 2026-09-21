# Glossary

The German parliamentary terms this project deals in, and the project's own terms.
Written for someone who knows software but not the Bundestag.

## The documents

**Kleine Anfrage** — a written question from members of parliament to the
government, which the government must answer in writing. The core instrument this
project collects. The Bundestag and most Länder use this name.

**Schriftliche Anfrage** — the same instrument under a different name, used by
Berlin and Bayern. Why `document_type` is a field rather than an assumption.

**Große Anfrage** — a larger written question, usually debated in plenary. Modelled
but not collected by any adapter yet.

**Antwort** — the government's written answer. Sometimes a separate Drucksache (the
Bundestag), sometimes the same PDF as the question (Berlin). Hence the
`question_pdf` / `answer_pdf` / `combined_pdf` roles on a source document.

**Drucksache** — a numbered parliamentary paper. Its number, the
*Drucksachennummer*, is the citation: `19/10006` is paper 10006 of the 19th
Wahlperiode. This project keeps it exactly as printed in `reference`.

**Wahlperiode** — the legislative period, the term between two elections. Numbering
restarts each period, so a Drucksachennummer is only unique within one.

**Plenarprotokoll** — the verbatim record of a plenary sitting. Present in the
feeds; not collected here.

**Vorgang** — a *procedure*: one parliamentary matter and every document belonging
to it. A Kleine Anfrage is one Vorgang with two documents.

**Vorgangsposition** — one step of a Vorgang, in the Bundestag's DIP data model.
The question and the answer are two positions of the same Vorgang.

**Urheber** — the originator. For a question, the MdBs or the Fraktion who asked;
for an answer, the ministry that signed it.

**Fraktion** — a parliamentary group. A Kleine Anfrage is often brought in by a
Fraktion rather than by named individuals; the record then names the Fraktion as
the asker with `role: "Fraktion"`, because inventing a person would be worse.

**Anlage** — an attachment. Answers frequently push their substance into `Anlage 1`,
which is a separate file the record references but does not contain.

**Verschlusssache / VS-NUR FÜR DEN DIENSTGEBRAUCH** — a classification marking.
`markers.classified` records that a document carries one.

## The systems

**DIP** — *Dokumentations- und Informationssystem für Parlamentsmaterialien*, the
Bundestag's documentation system, and the only real JSON API in this project.

**PARDOK** — the Abgeordnetenhaus von Berlin's parliamentary documentation, and the
name of its daily XML open-data export.

**Parlamentsspiegel** — the 16 Landtage's shared research portal, run by the
Landtag NRW. Roughly 984 000 Vorgänge. No API, and by its own statement no document
interface — it links to the owning Landtag.

**Parlamentsspiegel Export 1.0** — the XML DTD the Länder deliver to the
Parlamentsspiegel in. Berlin publishes its own feed in exactly this format, which is
why one parser (`src/sources/pardok.ts`) serves both.

**GLOMAS, j3s** — the two vendors whose systems most Landtage run. Neither was
designed for open data.

## This project's terms

**The line** — the deterministic runtime. Pinned code, pinned weights, no
generative model, same input → byte-identical output. `ka` is the line.

**The factory** — build-time tooling, where LLMs are allowed to live: they write the
extractors, propose the goldens, and run the repair loop. `ka-factory` is the
factory's own deterministic tooling; the agent that drives it is not shipped.

**Tier** — which deterministic path an adapter declares: `structured` (map fields),
`text_layer` (parse the PDF's text), `ocr` (a pinned perceptual model, then parse).

**Abstention** — the extractor refusing to produce a value it cannot derive with
certainty. Recorded in `abstained_fields`, surfaced by `ka review`. The project's
central safety mechanism: a record may publish with holes, because holes are honest
and invented content is not.

**Golden fixture** — a verified input→record pair, frozen on disk with the exact
input bytes. Because the line is deterministic these are real asserts, not fuzzy
scores.

**Drift** — an upstream changing under the line: a redesign, a moved endpoint, a new
document layout. Detected by watching discovery counts and abstention rates, and
repaired in the factory, never at runtime.

**Practical obscurity** — information that is technically public but effectively
unreachable because it is scattered, unindexed and non-aggregatable. The thing this
project exists to defeat. See CONCEPT.md §11.
