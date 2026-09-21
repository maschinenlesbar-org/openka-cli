// The Parlamentsspiegel — the Länder's shared research portal, run by the Landtag
// NRW, indexing the parliamentary business of all 16 Landtage (roughly 984 000
// Vorgänge / 2.3 million documents as of 2026, updated daily).
//
// The concept hoped this would be the cheapest `structured` source for many
// parliaments. It is not, and the adapter documents why rather than pretending
// otherwise: the portal publishes **no API**, and its own help text states that it
// stores no documents and therefore offers no download interface — it links to the
// owning Landtag. What it does have is a plain GET search form (`/suche`) whose
// result markup is stable and machine-readable, and whose links point at the
// Landtag PDFs.
//
// So this adapter is the project's one HTML scraper, and it is deliberately scoped
// to what an aggregator can honestly deliver: **metadata plus document URLs** for
// all 16 Länder. The question and answer texts come from fetching those PDFs, on
// the owning parliament's host.
//
// Two things follow, and both are recorded rather than hidden:
//   * its `ps-vorgang` class names are the contract, and a redesign breaks them —
//     discovery then returns zero refs, which is the drift signal the factory watches;
//   * the format it defines for the Länder to deliver in — `Parlamentsspiegel
//     Export 1.0` — is parsed by `pardok.ts`, and any Land that publishes that
//     export becomes a real structured source with no new parser. Berlin already does.

import { OpenKaError } from "../core/errors.js";
import { PARLIAMENTS, parliamentByHerkunft, type ParliamentKey } from "../core/models/parliaments.js";
import type { AnsweredBy, DocumentType, SourceDocumentRole } from "../core/models/schema.js";
import { parseGermanDate, parseUrheber } from "../core/extract/metadata.js";
import { blocksWithClass, firstHref, regionWithClass, spanTexts, visibleTextOf } from "./html.js";
import { applyWindow, type DiscoverOptions, type DiscoverResult, type DocRef, type DocRefDocument, type Source } from "./base.js";

export const PARLAMENTSSPIEGEL_BASE = "https://www.parlamentsspiegel.de";

/** Results per request. The form offers 5–100; 50 keeps the page count sane. */
const PAGE_SIZE = 50;

/** Never walk more pages than this in one run, however large the window is. */
const MAX_PAGES = 100;

/** `DokTyp` filter for Kleine Anfragen, as the portal's own quick link uses it. */
export const KLEINE_ANFRAGE_FILTER = "KlAnfr";

export class ParlamentsspiegelSource implements Source {
  readonly key: string;
  readonly parliament: ParliamentKey;
  readonly tier = "structured" as const;
  readonly label: string;
  readonly homepage = "https://www.parlamentsspiegel.de/suche";
  readonly notes =
    "No API and, by the portal's own statement, no document interface — it links to the owning " +
    "Landtag. This adapter parses the `/suche` result markup for metadata and PDF URLs; the class " +
    "names are the contract, so a redesign shows up as zero results rather than as wrong data.";

  /** Herkunft code this instance is pinned to (`NW`), or every Land when absent. */
  private readonly herkunft: string | undefined;

  constructor(parliament?: ParliamentKey) {
    if (parliament === undefined) {
      this.key = "parlamentsspiegel";
      // The aggregator spans 16 Länder; a record's parliament is read per result
      // from its Herkunft code, and this field only names the adapter's default.
      this.parliament = "nordrhein-westfalen";
      this.label = "Parlamentsspiegel (all 16 Länder)";
      this.herkunft = undefined;
      return;
    }
    const entry = PARLIAMENTS.find((candidate) => candidate.key === parliament);
    if (entry?.herkunft === undefined) {
      throw new OpenKaError(`${parliament} does not deliver to the Parlamentsspiegel`);
    }
    this.key = `parlamentsspiegel-${parliament}`;
    this.parliament = parliament;
    this.label = `Parlamentsspiegel (${entry.label})`;
    this.herkunft = entry.herkunft;
  }

  async discover(options: DiscoverOptions): Promise<DiscoverResult> {
    const warnings: string[] = [];
    const refs: DocRef[] = [];
    const seen = new Set<string>();

    for (let page = 1; page <= MAX_PAGES; page++) {
      // No free-text `query`: the portal's own quick link sends `query=Anfrage`,
      // but that is a full-text constraint on top of the structured filters, and it
      // silently drops entire Länder whose documents do not use the word
      // prominently — Sachsen returns 50 results without it and none with it. The
      // structured filters are what we actually mean.
      const params: Record<string, string | number> = {
        qyVTyp: "Anfrage",
        fqDTyp: KLEINE_ANFRAGE_FILTER,
        type: "vorgang",
        als: 0,
        size: PAGE_SIZE,
        page,
      };
      if (this.herkunft !== undefined) params["qyHerk"] = this.herkunft;
      if (options.since !== undefined) params["qyZeitAb"] = toGermanDate(options.since);
      if (options.until !== undefined) params["qyZeitBis"] = toGermanDate(options.until);

      const response = await options.engine.get(`${PARLAMENTSSPIEGEL_BASE}/suche`, {
        params,
        headers: { accept: "text/html" },
      });
      const html = response.body.toString("utf8");
      const blocks = blocksWithClass(html, "ps-vorgang", /<hr\s*\/?>/);
      if (blocks.length === 0) {
        if (page === 1) {
          warnings.push(
            "the search returned no `ps-vorgang` results — either the window is empty or the " +
              "portal's markup changed; this adapter reports nothing rather than guessing",
          );
        }
        break;
      }

      let added = 0;
      for (const block of blocks) {
        const ref = parseVorgangBlock(block, warnings);
        if (ref === undefined || seen.has(ref.key)) continue;
        seen.add(ref.key);
        refs.push(ref);
        added++;
      }
      // A page that adds nothing new means the pagination parameter did not move;
      // stopping here is what keeps a changed parameter name from looping forever.
      if (added === 0) break;
      if (options.limit !== undefined && refs.length >= options.limit) break;
    }

    return { refs: applyWindow(refs, options), warnings };
  }
}

/** `2024-03-01` -> `01.03.2024`, the form's own date format. */
export function toGermanDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (match === null) return iso;
  return `${match[3]}.${match[2]}.${match[1]}`;
}

const ID_PATTERN = /ps-detail-([A-Z]+)_V([A-Za-z0-9]+)_D([A-Za-z0-9]+)/;
/**
 * The paper's number in a result row. Most Länder label it "Drucksache"; Thüringen
 * labels the same thing "Dokument", and requiring the commoner word cost that Land
 * every one of its records.
 */
const DRUCKSACHE = /(?:Drucksache|Dokument)\s+(\d{1,2}\s*\/\s*[\d\s]+\d|\d{1,2}\/\d+)/;

/**
 * What kind of document a result row's primary entry is.
 *
 * The row reads "<Land> - <Typ>; …", and the type is not always the question.
 * Schleswig-Holstein files the Vorgang under "Antwort", because it publishes the
 * Kleine Anfrage and the government's reply as a *single* Drucksache — its
 * Fundstelle says so: "Kleine Anfrage Birte Pauls (SPD) und Antwort MSJFSIG".
 * Labelling that document `question_pdf` is not a cosmetic error: the extractor
 * picks which document to read by role, and a combined paper filed as a question
 * looks like an Anfrage nobody answered.
 */
export function documentRole(rowSummary: string, fundstelle: string): SourceDocumentRole {
  const combined = /\bAnfrage\b[\s\S]{0,120}?\bund\s+Antwort\b/i.test(fundstelle);
  if (combined) return "combined_pdf";
  // "<Land> - Antwort; …" with no question named anywhere: the answer alone.
  if (/-\s*Antwort\b/i.test(rowSummary) && !/\bAnfrage\b/i.test(rowSummary)) return "answer_pdf";
  return "question_pdf";
}

/** Parse one `ps-vorgang` result block into a DocRef. */
export function parseVorgangBlock(block: string, warnings: string[]): DocRef | undefined {
  const id = ID_PATTERN.exec(block);
  if (id === null) return undefined;
  const herkunft = id[1] as string;
  const parliament = parliamentByHerkunft(herkunft);
  if (parliament === undefined) {
    warnings.push(`unknown Herkunft code "${herkunft}" in result ${id[0]}`);
    return undefined;
  }

  // Everything before the first follow-up document belongs to the question. The
  // split is on the opening tag, not on the class attribute: slicing mid-tag would
  // leave the tail without its `<div`, and nothing downstream would match it.
  const folge = /<div[^>]*\sclass="(?:[^"]*\s)?ps-folge(?:\s[^"]*)?"[^>]*>/.exec(block);
  const head = folge === null ? block : block.slice(0, folge.index);
  const tail = folge === null ? "" : block.slice(folge.index);

  const titleRegion = regionWithClass(head, "ps-titel");
  const title = titleRegion === undefined ? "" : (spanTexts(titleRegion).pop() ?? "");

  const documentRegion = regionWithClass(head, "ps-dokument");
  if (documentRegion === undefined) return undefined;
  const url = firstHref(documentRegion);
  // Hidden spans are excluded: the row carries a "Neuestes Dokument" date that
  // belongs to the answer, and dating the question by it breaks every date window.
  const summary = visibleTextOf(documentRegion);
  const referenceMatch = DRUCKSACHE.exec(summary);
  if (referenceMatch === null) {
    warnings.push(`result ${id[0]}: no Drucksachennummer in the result row; skipped`);
    return undefined;
  }
  const reference = normaliseReference(referenceMatch[1] as string);
  const period = Number(reference.split("/")[0]);
  if (!Number.isInteger(period) || period < 1) return undefined;

  const fundstelleRegion = regionWithClass(head, "ps-fundstelle");
  const fundstelle = fundstelleRegion === undefined ? "" : visibleTextOf(fundstelleRegion);
  const role = documentRole(summary, fundstelle);

  const documents: DocRefDocument[] = [];
  if (url !== undefined && /^https?:/i.test(url)) {
    documents.push({ role, url, urlStable: urlIsStable(url) });
  }

  const urheberRegion = regionWithClass(head, "ps-urheber");
  const urheber = urheberRegion === undefined ? "" : (spanTexts(urheberRegion).pop() ?? "");

  const answer = parseFollowUps(tail);
  const answeredBy: AnsweredBy = {};
  if (answer?.ministry !== undefined) answeredBy.ministry = answer.ministry;
  if (answer?.url !== undefined) {
    documents.push({ role: "answer_pdf", url: answer.url, urlStable: urlIsStable(answer.url) });
  }

  const ref: DocRef = {
    key: `${herkunft}_V${id[2]}`,
    parliament: parliament.key,
    reference,
    legislative_period: period,
    title,
    documentType: documentTypeFor(parliament.key),
    askers: parseUrheber(urheber),
    answered_by: answeredBy,
    dates: {},
    documents,
  };
  // Which date the row carries depends on what the row's document is. For a paper
  // that holds question and answer together, the one printed date is the date the
  // combined paper appeared — the answer's. The question's own date is not in the
  // row, and guessing one would be worse than leaving it out.
  const rowDate = findRowDate(summary);
  if (rowDate !== undefined) {
    if (role === "question_pdf") ref.dates.submitted = rowDate;
    else ref.dates.answered = rowDate;
  }
  if (answer?.date !== undefined) ref.dates.answered = answer.date;
  return ref;
}

/** The Antwort among a Vorgang's follow-up documents, if it lists one. */
function parseFollowUps(tail: string): { url?: string; date?: string; ministry?: string } | undefined {
  if (tail === "") return undefined;
  for (const folge of blocksWithClass(tail, "ps-folge")) {
    const region = regionWithClass(folge, "ps-dokument");
    if (region === undefined) continue;
    const summary = visibleTextOf(region);
    if (!/\bAntwort\b/.test(summary)) continue;
    const out: { url?: string; date?: string; ministry?: string } = {};
    const url = firstHref(region);
    if (url !== undefined && /^https?:/i.test(url)) out.url = url;
    const date = findRowDate(summary);
    if (date !== undefined) out.date = date;
    // `Nordrhein-Westfalen - Antwort 5343. MKJFGFI - Drucksache 18/14035, …`
    const ministry = /\bAntwort\s+\d*\.?\s*([^-]+?)\s+-\s+Drucksache/.exec(summary);
    if (ministry !== null) {
      const name = (ministry[1] as string).trim();
      if (name !== "") out.ministry = name;
    }
    return out;
  }
  return undefined;
}

/** The last German date in a result row: the row ends with the document's date. */
function findRowDate(summary: string): string | undefined {
  const pattern = /(\d{1,2}\.\d{1,2}\.\d{4})/g;
  let last: string | undefined;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(summary)) !== null) last = match[1];
  return last === undefined ? undefined : parseGermanDate(last);
}

function normaliseReference(raw: string): string {
  const [period, number] = raw.split("/");
  return `${(period ?? "").trim()}/${(number ?? "").replace(/\s+/g, "")}`;
}

/**
 * Sachsen's document links carry a session token and expire after about fifteen
 * minutes — the archived blob is then the only retrievable copy, which is exactly
 * what `url_stable: false` tells a reader of the record.
 */
function urlIsStable(url: string): boolean {
  return !/edas\.landtag\.sachsen\.de/i.test(url);
}

/** Bayern and Berlin call the instrument a Schriftliche Anfrage. */
function documentTypeFor(parliament: ParliamentKey): DocumentType {
  return parliament === "berlin" || parliament === "bayern" ? "schriftliche_anfrage" : "kleine_anfrage";
}
