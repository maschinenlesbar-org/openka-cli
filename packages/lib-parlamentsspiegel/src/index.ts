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

import { OpenKaError, UsageError } from "@maschinenlesbar.org/openka-lib-errors";
import { parliamentByKey, PARLIAMENTS, parliamentByHerkunft, type ParliamentKey } from "@maschinenlesbar.org/openka-lib-models";
import type { AnsweredBy, DocumentType, SourceDocumentRole } from "@maschinenlesbar.org/openka-lib-models";
import { parseGermanDate, parseUrheber } from "@maschinenlesbar.org/openka-lib-extract";
import { blocksWithClass, firstHref, regionWithClass, spanTexts, visibleTextOf } from "@maschinenlesbar.org/openka-lib-source";
import { parseReference, periodNumber } from "@maschinenlesbar.org/openka-lib-models";
import {
  applyWindow,
  type CountOptions,
  type DiscoverOptions,
  type DiscoverResult,
  type DocRef,
  type DocRefDocument,
  type Source,
  type UpstreamCount,
} from "@maschinenlesbar.org/openka-lib-source";

export const PARLAMENTSSPIEGEL_BASE = "https://www.parlamentsspiegel.de";

/** Results per request. The form offers 5–100; 50 keeps the page count sane. */
const PAGE_SIZE = 50;

/**
 * Never walk more pages than this in one run, however large the window is. Hitting
 * it is said, not hidden: Sachsen-Anhalt alone holds ~20,000 Kleine Anfragen (live
 * count, 2026-10-07), four times what one walk reads, newest first.
 */
export const MAX_PAGES = 100;

/**
 * The portal's first result page. `page` counts from 0: `page=1` is the *second*
 * page, which the result count confirms ("Seite 2 von …"). Discovery started at 1
 * and so skipped the newest `PAGE_SIZE` results of every search — and a window with
 * no more than that many came back empty: Saarland's September 2026, with 15
 * Kleine Anfragen, discovered none.
 */
export const FIRST_PAGE = 0;

/** `DokTyp` filter for Kleine Anfragen, as the portal's own quick link uses it. */
export const KLEINE_ANFRAGE_FILTER = "KlAnfr";

/**
 * Walk the portal's result pages. Shared by both adapters below; `herkunft` pins
 * the search to one Land, or covers every Land when absent.
 */
async function discoverFromPortal(
options: DiscoverOptions,
herkunft: string | undefined,
only?: ParliamentKey,
): Promise<DiscoverResult> {
  const warnings: string[] = [];
  const refs: DocRef[] = [];
  const seen = new Set<string>();
  // Rows of another Land that came back although the search was pinned to `only`
  // (`qyHerk`). Each row names its own Land, so they would be filed correctly — but
  // under this source's run, counted as its own, past those Länder's connectors and
  // their rules. Left out, and counted for the warning.
  const foreign = new Map<string, number>();

  // Set when the last page walked was full of new rows: the portal has more.
  let moreLeft = false;
  for (let page = FIRST_PAGE; page < FIRST_PAGE + MAX_PAGES; page++) {
    moreLeft = false;
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
    if (herkunft !== undefined) params["qyHerk"] = herkunft;
    if (options.since !== undefined) params["qyZeitAb"] = toGermanDate(options.since);
    if (options.until !== undefined) params["qyZeitBis"] = toGermanDate(options.until);

    const response = await options.engine.get(`${PARLAMENTSSPIEGEL_BASE}/suche`, {
      params,
      headers: { accept: "text/html" },
    });
    const html = response.body.toString("utf8");
    const blocks = blocksWithClass(html, "ps-vorgang", /<hr\s*\/?>/);
    if (blocks.length === 0) {
      if (page === FIRST_PAGE) {
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
      // A foreign row still moves the page on: it counts for the loop guard below.
      added++;
      if (only !== undefined && ref.parliament !== only) {
        const land = ref.parliament ?? "unknown";
        foreign.set(land, (foreign.get(land) ?? 0) + 1);
        continue;
      }
      refs.push(ref);
    }
    // A page that adds nothing new means the pagination parameter did not move;
    // stopping here is what keeps a changed parameter name from looping forever.
    if (added === 0) break;
    if (options.limit !== undefined && refs.length >= options.limit) break;
    moreLeft = blocks.length >= PAGE_SIZE;
  }
  if (moreLeft) {
    warnings.push(
      `discovery stopped after ${MAX_PAGES} pages (${MAX_PAGES * PAGE_SIZE} results, newest first) and the portal ` +
        "has more: the older Anfragen of this window were not discovered — sync it in parts with --since/--until",
    );
  }

  if (foreign.size > 0) {
    const total = [...foreign.values()].reduce((sum, n) => sum + n, 0);
    const which = [...foreign].map(([land, n]) => `${land} ${n}`).join(", ");
    warnings.push(
      `the search for ${herkunft as string} also returned ${total} row(s) of other Länder (${which}); they were left ` +
        "out — they belong to those Länder's own sources",
    );
  }
  return { refs: applyWindow(refs, options), warnings };
}

/**
 * The result count a search page prints: `<b>69.935</b> <span>Vorgänge</span>`,
 * German thousands separators and all. Undefined when the page carries none.
 */
export function parseResultCount(html: string): number | undefined {
  const match = /<b>\s*([\d.]+)\s*<\/b>\s*<span>\s*Vorgänge\s*<\/span>/.exec(html);
  if (match === null) return undefined;
  const total = Number((match[1] as string).replace(/\./g, ""));
  return Number.isSafeInteger(total) ? total : undefined;
}

/**
 * Count the Kleine Anfragen the portal holds, for one Land or for all: one search
 * request with the filters discovery uses, the smallest page the form offers, and
 * the total the page prints. The portal has no Wahlperiode filter, so a `period`
 * is refused rather than answered with the count of every period.
 */
async function countFromPortal(options: CountOptions, herkunft: string | undefined): Promise<UpstreamCount> {
  if (options.period !== undefined) {
    throw new UsageError("the Parlamentsspiegel cannot count by Wahlperiode; leave out --period for this source");
  }
  const params: Record<string, string | number> = {
    qyVTyp: "Anfrage",
    fqDTyp: KLEINE_ANFRAGE_FILTER,
    type: "vorgang",
    als: 0,
    size: 5,
    page: FIRST_PAGE,
  };
  if (herkunft !== undefined) params["qyHerk"] = herkunft;
  const response = await options.engine.get(`${PARLAMENTSSPIEGEL_BASE}/suche`, { params, headers: { accept: "text/html" } });
  const html = response.body.toString("utf8");
  const total = parseResultCount(html);
  // No count is not zero: it is a page whose markup moved, or one this reader was
  // never shown. Reading it as an empty upstream would be the wrong answer.
  if (total === undefined) throw new OpenKaError("the Parlamentsspiegel printed no result count — its markup may have changed");
  return { total, basis: "Parlamentsspiegel" };
}

/**
 * The portal as one Land's source.
 *
 * Split from the all-Länder adapter, which used to be the same class in a second
 * mode. That class had to invent a `parliament` it did not have — the field was
 * documented as "only names the adapter's default" — and the placeholder leaked
 * twice: `ka sources list` reported one Land's record count under the aggregator
 * row, and every aggregator-backed Land reported "never synced" straight after a
 * sync because the two modes disagreed about what `key` meant. Two types cannot
 * disagree about which fields they have.
 */
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

  /** Herkunft code this Land is known by in the portal (`NW`). */
  private readonly herkunft: string;

  constructor(parliament: ParliamentKey) {
    const entry = PARLIAMENTS.find((candidate) => candidate.key === parliament);
    if (entry?.herkunft === undefined) {
      throw new OpenKaError(`${parliament} does not deliver to the Parlamentsspiegel`);
    }
    // The key must be the one the registry lists this Land under: the pipeline
    // stores sync state under `source.key` while `ka sources list` and the health
    // report read it back by the registry key.
    this.key = parliament;
    this.parliament = parliament;
    this.label = `Parlamentsspiegel (${entry.label})`;
    this.herkunft = entry.herkunft;
  }

  async discover(options: DiscoverOptions): Promise<DiscoverResult> {
    return discoverFromPortal(options, this.herkunft, this.parliament);
  }

  async count(options: CountOptions): Promise<UpstreamCount> {
    return countFromPortal(options, this.herkunft);
  }
}

/**
 * The portal as one source covering every Land that delivers to it.
 *
 * It has no `parliament` of its own, and says so by not declaring one: each
 * record's parliament is read per result from its Herkunft code, so there is
 * nothing for the adapter to fall back to and nothing for a report to count.
 */
export class ParlamentsspiegelAllLaender implements Source {
  readonly key = "parlamentsspiegel";
  readonly tier = "structured" as const;
  readonly label = "Parlamentsspiegel (all 16 Länder)";
  readonly homepage = "https://www.parlamentsspiegel.de/suche";
  readonly notes =
    "No API and, by the portal's own statement, no document interface — it links to the owning " +
    "Landtag. This adapter parses the `/suche` result markup for metadata and PDF URLs; the class " +
    "names are the contract, so a redesign shows up as zero results rather than as wrong data.";

  async discover(options: DiscoverOptions): Promise<DiscoverResult> {
    return discoverFromPortal(options, undefined);
  }

  async count(options: CountOptions): Promise<UpstreamCount> {
    return countFromPortal(options, undefined);
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

/**
 * Bayern publishes a Schriftliche Anfrage as one Drucksache holding the question
 * list and the government's answer, filed under "Schriftliche Anfragen", and only
 * once it is answered; the portal lists that one paper with no follow-up and no
 * marker in the Fundstelle. Read as a question paper, its date — the paper's, two
 * or three months after the question (golden 19/6524: 10.06.2025 for a question of
 * 31.03.2025; live 19/13354: 28.09.2026 for 26.06.2026) — was stored as the date the
 * Anfrage was asked. As the combined paper it is, the row's date is the answer's,
 * and the question's date comes from the paper's head (`readAnfrageHead`).
 */
function combinedByLand(parliament: ParliamentKey, role: SourceDocumentRole): SourceDocumentRole {
  return parliament === "bayern" && role === "question_pdf" ? "combined_pdf" : role;
}

/**
 * The document URL of a row's link. For some Sachsen-Anhalt papers the portal glues
 * two URLs into one `href` — `…/d7036dak.pdfhttps://…/d7036dak.doc` (issue #20), both
 * halves of which answer 200 — and the string was fetched as one URL, answered 404,
 * and the record was stored without its document. The parts are split at each
 * `http(s)://`; the first PDF is taken, else the first part, and the rest are named
 * in a warning rather than dropped without a word.
 */
export function documentUrl(href: string | undefined, warnings: string[], reference: string): string | undefined {
  if (href === undefined) return undefined;
  const parts = href.split(/(?=https?:\/\/)/i).filter((part) => /^https?:\/\//i.test(part));
  if (parts.length <= 1) return /^https?:/i.test(href) ? href : undefined;
  const chosen = parts.find((part) => /\.pdf(?:$|[?#])/i.test(part)) ?? (parts[0] as string);
  const left = parts.filter((part) => part !== chosen);
  warnings.push(
    `${reference}: the portal's document link holds ${parts.length} URLs glued together (${href}); ` +
      `took ${chosen} and left out ${left.join(", ")}`,
  );
  return chosen;
}

/** The "N weitere Dokumente" header that every row with follow-ups carries. */
const FOLGE_MARKER = /<p[^>]*\sclass="(?:[^"]*\s)?ps-folge-dok(?:\s[^"]*)?"[^>]*>/;

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
  //
  // `ps-folge-dok` — the "N weitere Dokumente" header — is the marker, not the
  // `ps-folge` div that holds them. The portal only puts that class on the div when
  // the search filtered some of the follow-ups away; a row with
  // "0 gefiltert/ausgeblendet" renders the same markup under a bare `<div >`.
  // Splitting on `ps-folge` therefore lost the answer for every unfiltered row —
  // measured on the recorded payloads, that was all of Niedersachsen and Thüringen.
  const folge = FOLGE_MARKER.exec(block);
  const head = folge === null ? block : block.slice(0, folge.index);
  const tail = folge === null ? "" : block.slice(folge.index);

  const titleRegion = regionWithClass(head, "ps-titel");
  const title = titleRegion === undefined ? "" : (spanTexts(titleRegion).pop() ?? "");

  const documentRegion = regionWithClass(head, "ps-dokument");
  if (documentRegion === undefined) return undefined;
  const href = firstHref(documentRegion);
  // Hidden spans are excluded: the row carries a "Neuestes Dokument" date that
  // belongs to the answer, and dating the question by it breaks every date window.
  const summary = visibleTextOf(documentRegion);
  const referenceMatch = DRUCKSACHE.exec(summary);
  if (referenceMatch === null) {
    warnings.push(`result ${id[0]}: no Drucksachennummer in the result row; skipped`);
    return undefined;
  }
  const reference = normaliseReference(referenceMatch[1] as string);
  const parsed = parseReference(reference);
  const period = parsed === undefined ? Number.NaN : periodNumber(parsed);
  if (!Number.isInteger(period) || period < 1) return undefined;

  const fundstelleRegion = regionWithClass(head, "ps-fundstelle");
  const fundstelle = fundstelleRegion === undefined ? "" : visibleTextOf(fundstelleRegion);
  const role = combinedByLand(parliament.key, documentRole(summary, fundstelle));

  const documents: DocRefDocument[] = [];
  const url = documentUrl(href, warnings, reference);
  if (url !== undefined) documents.push({ role, url, urlStable: urlIsStable(url) });

  const urheberRegion = regionWithClass(head, "ps-urheber");
  const urheber = urheberRegion === undefined ? "" : (spanTexts(urheberRegion).pop() ?? "");
  const { askers, bodies } = parseUrheber(urheber);

  const answer = parseFollowUps(tail, warnings, reference);
  const answeredBy: AnsweredBy = {};
  if (answer?.ministry !== undefined) answeredBy.ministry = answer.ministry;
  // Schleswig-Holstein publishes question and answer as one document, so there is
  // no follow-up row to read: the minister who answered is named in the same
  // Urheber field as the asker.
  else if (bodies[0] !== undefined) answeredBy.ministry = bodies[0];
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
    askers,
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

/**
 * One segment per follow-up document: the `ps-dokument` row that names it, plus
 * the `ps-titel`/`ps-urheber` fields the portal prints under it, up to the next
 * follow-up. Sachsen files an Antwort and a Berichtigung under one Vorgang, so
 * the fields have to stay attached to the row they describe.
 */
function followUpSegments(tail: string): string[] {
  const opener = /<p[^>]*\sclass="(?:[^"]*\s)?ps-dokument(?:\s[^"]*)?"[^>]*>/g;
  const starts: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = opener.exec(tail)) !== null) starts.push(match.index);
  return starts.map((start, index) => tail.slice(start, starts[index + 1] ?? tail.length));
}

/** The Antwort among a Vorgang's follow-up documents, if it lists one. */
function parseFollowUps(tail: string, warnings: string[], reference: string): { url?: string; date?: string; ministry?: string } | undefined {
  if (tail === "") return undefined;
  for (const segment of followUpSegments(tail)) {
    const region = regionWithClass(segment, "ps-dokument");
    if (region === undefined) continue;
    const summary = visibleTextOf(region);
    // Sachsen abbreviates it: its follow-up row reads "Sachsen - Antw SMI 13.08.2025".
    // Requiring the full word cost that Land every answer it publishes.
    if (!/\bAntw(?:ort)?\b\.?/.test(summary)) continue;
    const out: { url?: string; date?: string; ministry?: string } = {};
    const url = documentUrl(firstHref(region), warnings, reference);
    if (url !== undefined) out.url = url;
    const date = findRowDate(summary);
    if (date !== undefined) out.date = date;
    // The answering body comes from the row's own `Urheber` field, not from the
    // summary line. Reading the summary meant guessing where the name started:
    // "Antwort 5516. MUNV - Drucksache …" and "Antwort. Landesregierung - …" both
    // parsed, but Thüringen's "Antwort auf Kleine Anfrage. Ministerium für …"
    // yielded "auf Kleine Anfrage. Ministerium für …", and Sachsen's "Antw SMI
    // 12.08.2025 Drs 8/3351" — no " - Drucksache" — yielded nothing at all.
    const urheberRegion = regionWithClass(segment, "ps-urheber");
    const ministry = urheberRegion === undefined ? "" : undecorated((spanTexts(urheberRegion).pop() ?? "").trim());
    if (ministry !== "") out.ministry = ministry;
    return out;
  }
  return undefined;
}

/**
 * The ministry as it is named, without what the portal appends to it. Thüringen's
 * rows read "Ministerium für Umwelt, Energie, Naturschutz und Forsten (8. Wp),
 * TMUENF" — the Wahlperiode and the ministry's acronym — so no two Länder's
 * ministries could be grouped or searched by name. Only that exact tail is cut; an
 * acronym standing alone (NRW's "MUNV", Sachsen's "SMI") is all the row says and is
 * kept as it is.
 */
export function undecorated(ministry: string): string {
  const decorated = /^(.+?)\s*\(\d{1,2}\.\s*Wp\.?\)\s*(?:,\s*[A-ZÄÖÜ]{2,12})?$/u.exec(ministry);
  return decorated === null ? ministry : (decorated[1] as string).trim();
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

/**
 * Which instrument a Land's rows are.
 *
 * Read from the parliament table, where each Land declares it beside the name it
 * uses — Bayern and Berlin call it a Schriftliche Anfrage, Hamburg a Schriftliche
 * Kleine Anfrage. This used to be a two-Land conditional here, duplicating that
 * table and covering the other fifteen by an else-branch.
 *
 * It is a property of the parliament rather than of the document on purpose: the
 * portal does not label the instrument per row in a form we can trust — its own
 * type filter is what constrains the search (`fqDTyp=KlAnfr`), which is also why
 * `grosse_anfrage` cannot come out of this adapter. Reading the row's "Kleine
 * Anfrage;" label instead was considered and rejected: it appears to be the
 * portal's filter category rather than the Land's own word for the instrument,
 * and no Berlin or Bayern row is recorded in `fixtures/payloads/` to settle it.
 * A row from either Land would.
 */
function documentTypeFor(parliament: ParliamentKey): DocumentType {
  return parliamentByKey(parliament)?.documentType ?? "kleine_anfrage";
}
