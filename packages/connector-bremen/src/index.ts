// Bremen: the Bürgerschaft's own PARiS, a STARWEB installation.
//
// PARiS is not an API — see `lib-starweb` for the session handshake it needs. What
// is Bremen-specific is what a result line says and where the documents live.
//
// **The type lives in `Dokumenttyp`, not in `Vorgangstyp`.** Searching
// `06_LISSH_VTYP=Kleine Anfrage` returns nothing at all, with no error; the field
// that works is `07_LISSH_DTYP`. This is the sort of thing that has to be measured
// rather than reasoned about, because a wrong field here is indistinguishable from
// a Land that published nothing.
//
// **The Bürgerschaft is two chambers.** A Drucksache is filed either as Land
// (`D21L1983`) or as Stadt, and only the Land chamber's Kleine Anfragen are
// parliamentary questions to a Landesregierung in the sense this corpus means. The
// result line carries the marker and the PDF name repeats it.
//
// **The PDF is linked directly** on `www.bremische-buergerschaft.de`, so there is no
// viewer to resolve. That host's robots.txt disallows a handful of named crawlers —
// BLEXBot, MJ12bot, AhrefsBot, GPTBot — and nothing else; `User-agent: *` is not
// restricted. This tool is not a crawler: it fetches documents a person asked for,
// at the rate limit the engine imposes.

import { parseGermanDate } from "@maschinenlesbar.org/openka-lib-extract";
import {
  FallbackSource,
  type DiscoverOptions,
  type DiscoverResult,
  type DocRef,
  type Source,
  type SourceEntry,
} from "@maschinenlesbar.org/openka-lib-source";
import { ParlamentsspiegelSource } from "@maschinenlesbar.org/openka-lib-parlamentsspiegel";
import {
  blockText,
  noHits,
  openSearch,
  pdfHref,
  recordBlocks,
  runSearch,
  totalHits,
  type StarwebEndpoint,
} from "@maschinenlesbar.org/openka-lib-starweb";
import type { Asker } from "@maschinenlesbar.org/openka-lib-models";

export const PARLIAMENT = "bremen" as const;
export const LABEL = "Bremische Bürgerschaft";

export const PARIS: StarwebEndpoint = {
  servlet: "https://paris.bremische-buergerschaft.de/starweb/paris/servlet.starweb",
  searchPath: "paris/LISSH.web",
};

/** The Wahlperiode currently sitting; the default window when none is given. */
export const BREMEN_LATEST_PERIOD = 21;

/**
 * The search fields, named as the template names them. `07_LISSH_DTYP` is the one
 * that selects a Kleine Anfrage; `06_LISSH_VTYP` looks like it should and does not.
 */
export const FIELD = {
  documentType: "07_LISSH_DTYP",
  period: "12_LISSH_WP",
  dateFrom: "13_LISSH_FASTDATV",
  dateTo: "14_LISSH_FASTDATB",
} as const;

/**
 * A result line, in its two forms:
 *
 *   Drs 21/1983 ,   Kleine Anfrage vom 10.09.2026 BIW     <- Land
 *   Drs 21/905 S ,  Kleine Anfrage vom 09.09.2026 BIW     <- Stadt
 *
 * The `S` is the chamber marker and it sits **inside the line**, before the comma.
 * It is captured rather than left to break the match: a Stadt paper that fails to
 * parse is indistinguishable from a template that changed, and this adapter should
 * be able to say "that one is the Stadtbürgerschaft's" instead of going quiet.
 *
 * The Fraktion is the tail; the title comes from the head of the block, before the
 * thesaurus keywords.
 */
const LINE = /Drs\s+(\d+)\/(\d+)\s*(S)?\s*,\s*([^,]*?)\s+vom\s+(\d{1,2}\.\d{1,2}\.\d{4})\s*(.*)$/;

export interface BremenRecordLine {
  reference: string;
  period: number;
  /**
   * Which of the Bürgerschaft's two chambers filed it. Only `land` papers are
   * questions to a Landesregierung in the sense this corpus means; the
   * Stadtbürgerschaft's are municipal.
   */
  chamber: "land" | "stadt";
  documentType: string;
  date: string;
  fraktion?: string;
}

/** Read the `Drs …, <Typ> vom <Datum> <Fraktion>` line out of a record block. */
export function parseRecordLine(text: string): BremenRecordLine | undefined {
  const match = LINE.exec(text);
  if (match === null) return undefined;
  const period = Number(match[1]);
  if (!Number.isInteger(period) || period < 1) return undefined;
  const line: BremenRecordLine = {
    reference: `${match[1]}/${match[2]}`,
    period,
    chamber: match[3] === "S" ? "stadt" : "land",
    documentType: (match[4] ?? "").trim(),
    date: match[5] as string,
  };
  const fraktion = (match[6] ?? "").trim();
  if (fraktion !== "") line.fraktion = fraktion;
  return line;
}

/**
 * The title: the block opens with a chamber marker and the title, before the
 * comma-separated thesaurus keywords the record is indexed under.
 */
export function parseTitle(text: string): string {
  const upTo = text.search(/\bDrs\s+\d+\//);
  const head = (upTo > 0 ? text.slice(0, upTo) : text).trim();
  // "L " / "S " is the chamber, not part of the title.
  const withoutChamber = head.replace(/^[LS]\s+/, "");
  // The keywords follow the title and are separated by " , ".
  const [title] = withoutChamber.split(" , ");
  return (title ?? "").trim();
}

export class BremenParisSource implements Source {
  readonly key = PARLIAMENT;
  readonly parliament = PARLIAMENT;
  readonly tier = "text_layer" as const;
  readonly label = `${LABEL} (PARiS)`;
  readonly homepage = "https://paris.bremische-buergerschaft.de/";
  readonly notes =
    "The Bürgerschaft's own PARiS, a STARWEB installation: a stateful HTML form rather than an " +
    "API, so a search opens a session first. The type is selected through Dokumenttyp — " +
    "Vorgangstyp silently matches nothing — and only the Land chamber's Drucksachen are taken. " +
    "The PDF is linked directly, so there is no viewer to resolve.";

  async discover(options: DiscoverOptions): Promise<DiscoverResult> {
    const warnings: string[] = [];
    const session = await openSearch(options.engine, PARIS);
    if (session === undefined) {
      return { refs: [], warnings, unreadable: "the PARiS search form carried no session state" };
    }

    const search: Record<string, string> = {
      [FIELD.documentType]: "Kleine Anfrage",
      [FIELD.period]: String(options.period ?? BREMEN_LATEST_PERIOD),
    };
    if (options.since !== undefined) search[FIELD.dateFrom] = german(options.since);
    if (options.until !== undefined) search[FIELD.dateTo] = german(options.until);

    const html = await runSearch(options.engine, PARIS, session, search);
    if (noHits(html)) return { refs: [], warnings };

    const blocks = recordBlocks(html);
    if (blocks.length === 0) {
      // Neither hits nor the "keine Treffer" message: the template changed, or the
      // session was not accepted. Either way this is not an empty Wahlperiode.
      return { refs: [], warnings, unreadable: "the PARiS result page held neither records nor a no-hits message" };
    }

    // PARiS shows at most one page ("max. Trefferanzeige 200") and says how many
    // it matched. A window that matched more than it showed must not read as a
    // window that held exactly that many.
    const total = totalHits(html);
    if (total !== undefined && total > blocks.length) {
      warnings.push(
        `PARiS matched ${total} Vorgänge but showed ${blocks.length}; the rest were not read — ` +
          "narrow the window with --since/--until to reach them",
      );
    }

    const refs: DocRef[] = [];
    for (const block of blocks) {
      const ref = toRef(block, warnings);
      if (ref !== undefined) refs.push(ref);
      if (options.limit !== undefined && refs.length >= options.limit) break;
    }
    return { refs, warnings };
  }
}

function german(iso: string): string {
  const [year, month, day] = iso.split("-");
  return `${day}.${month}.${year}`;
}

/** One record block as a DocRef, or `undefined` when it is not one of ours. */
export function toRef(block: string, warnings: string[]): DocRef | undefined {
  const text = blockText(block);
  const line = parseRecordLine(text);
  if (line === undefined) return undefined;
  if (!/Kleine Anfrage/i.test(line.documentType)) return undefined;
  // The Stadtbürgerschaft's Kleine Anfragen are municipal business, not questions
  // to a Landesregierung, so they are not this corpus's subject.
  if (line.chamber === "stadt") return undefined;
  const url = pdfHref(block);
  if (url === undefined) {
    warnings.push(`Drs ${line.reference}: the result row links no PDF; skipped`);
    return undefined;
  }
  const submitted = parseGermanDate(line.date);
  return {
    key: `paris:${line.reference}`,
    reference: line.reference,
    legislative_period: line.period,
    title: parseTitle(text),
    documentType: "kleine_anfrage",
    askers: askersOf(line.fraktion),
    answered_by: {},
    dates: submitted === undefined ? {} : { submitted },
    documents: [{ role: "question_pdf", url, urlStable: true }],
  };
}

/**
 * Bremen's result line names the **Fraktion**, not the members.
 *
 * So there are no askers to report, and inventing a person called "BIW" would be
 * exactly the kind of manufactured fact this project exists to avoid. The Fraktion
 * is carried as an asker with no name only where it can be, which is nowhere: the
 * schema's `Asker` requires a name. It is therefore dropped here, and the members
 * are left to the document.
 */
export function askersOf(_fraktion: string | undefined): Asker[] {
  return [];
}

/** The Bürgerschaft's own PARiS, with the Parlamentsspiegel behind it. */
export function createSource(): Source {
  return new FallbackSource(new BremenParisSource(), new ParlamentsspiegelSource(PARLIAMENT));
}

/** How this connector announces itself to the registry and `ka sources list`. */
export const ENTRY: SourceEntry = {
  key: PARLIAMENT,
  parliament: PARLIAMENT,
  label: LABEL,
  status: "implemented",
  note: "the Bürgerschaft's own PARiS (STARWEB), with the Parlamentsspiegel as a fallback",
  factory: createSource,
};
