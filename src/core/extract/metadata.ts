// Deterministic metadata rules over a document's plain text: German dates,
// Drucksachen references, askers, the answering ministry, and the document markers.
//
// Every function here returns `undefined` rather than a best guess when its pattern
// does not match. Callers turn that into an abstention.

import { isCalendarDate } from "../models/validate.js";
import { formatReference, parseReference, periodNumber } from "../models/reference.js";

const MONTHS: Record<string, number> = {
  januar: 1, februar: 2, "märz": 3, maerz: 3, april: 4, mai: 5, juni: 6, juli: 7,
  august: 8, september: 9, oktober: 10, november: 11, dezember: 12,
  jan: 1, feb: 2, "mrz": 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, okt: 10, nov: 11, dez: 12,
};

function iso(year: number, month: number, day: number): string | undefined {
  const text = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return isCalendarDate(text) ? text : undefined;
}

/**
 * Parse the German date forms that appear in parliamentary documents:
 * `04.11.2021`, `4. November 2021`, `04. Nov. 2021`, and ISO `2021-11-04`.
 * Two-digit years are rejected rather than windowed — guessing a century is
 * exactly the kind of plausible-but-wrong value this project refuses to produce.
 */
export function parseGermanDate(text: string): string | undefined {
  const trimmed = text.trim();
  let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (match) return iso(Number(match[1]), Number(match[2]), Number(match[3]));

  match = /^(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})$/.exec(trimmed);
  if (match) return iso(Number(match[3]), Number(match[2]), Number(match[1]));

  match = /^(\d{1,2})\.\s*([A-Za-zÄÖÜäöü]+)\.?\s*(\d{4})$/.exec(trimmed);
  if (match) {
    const month = MONTHS[(match[2] as string).toLowerCase()];
    if (month !== undefined) return iso(Number(match[3]), month, Number(match[1]));
  }
  return undefined;
}

/** Find the first German date anywhere in `text`, scanning left to right. */
export function findDate(text: string): string | undefined {
  const pattern = /(\d{1,2}\.\s*(?:\d{1,2}\.\s*\d{4}|[A-Za-zÄÖÜäöü]+\.?\s*\d{4}))|(\d{4}-\d{2}-\d{2})/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const parsed = parseGermanDate(match[0]);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

/**
 * The shape of a Drucksachennummer: `19/10006`, `19 / 10 006`, `18/27 064`.
 *
 * Spaces and tabs only, never a newline. `\s` let the pattern weld two lines of a
 * PDF text layer together, so "19/10" ending one line and "006" starting the next
 * read as Drucksache 19/10006 — a fabricated document identity, which is worse
 * than no reference at all.
 */
const REFERENCE_BODY = String.raw`(\d{1,2})[ \t]*\/[ \t]*((?:\d[\d \t]{0,10}\d|\d))`;

/**
 * What a German parliament prints before the number.
 *
 * Taken from the corpus rather than guessed. Across the fifteen goldens — ten
 * parliaments — the number is introduced three ways: `Drucksache` (eleven of them,
 * `DRUCKSACHE` in Sachsen, sometimes as `BT-Drs.` or `Drucks. Nr.`), `Schriftliche
 * Anfrage Nr.` (Berlin), and `Kleine Anfrage` (Thüringen, which labels the question
 * paper by its document type and keeps `Drucksache` for the answer). `Große
 * Anfrage` completes the set of document types the schema declares.
 */
const REFERENCE_LABEL = String.raw`(?:(?:[A-Za-zÄÖÜäöü]{1,4}-)?(?:Drucksachen?|Drucks\.?|Drs\.?)|(?:Kleine|Schriftliche|Gro(?:ß|ss)e)[ \t]+Anfrage)[ \t]*(?:Nr\.?[ \t]*)?`;

/**
 * Find the Drucksachennummer in a document's text.
 *
 * The number has to be introduced by its label. A bare `a/b` is not evidence of a
 * Drucksachennummer and reading one as such produced real misreadings: a page
 * header `Seite 2 / 4` became reference `2/4`, `im Verhältnis 2/3` became `2/3`,
 * and `Stand 11/2024` became `11/2024` — each a document identity that does not
 * exist. Structure cannot separate them, because `11/2024` is a perfectly
 * well-formed reference; only the label can. With no labelled number this returns
 * `undefined` and the caller abstains, which is the honest answer.
 */
export function findReference(text: string): string | undefined {
  const match = new RegExp(REFERENCE_LABEL + REFERENCE_BODY, "i").exec(text);
  return match === null ? undefined : normaliseReference(match);
}

function normaliseReference(match: RegExpExecArray): string | undefined {
  const parsed = parseReference(`${match[1]}/${match[2]}`);
  return parsed === undefined ? undefined : formatReference(parsed);
}

/** The legislative period from a reference such as `19/10006`. */
export function periodFromReference(reference: string): number | undefined {
  const parsed = parseReference(reference);
  if (parsed === undefined) return undefined;
  const period = periodNumber(parsed);
  return Number.isInteger(period) && period > 0 ? period : undefined;
}

export interface ParsedAsker {
  name: string;
  party?: string;
}

/**
 * Split a PARDOK-style Urheber field into askers.
 *
 * The forms seen in the export are `Otto, Andreas (Grüne)`, `Tabor, Tommy (AfD)`,
 * and for Hamburg's aggregator rows `Goldner, Antonia-Katharina, Dr., CDU; …; CDU`.
 * The name is normalised from `Surname, Given` to `Given Surname`, which is how a
 * person is actually named; the printed form stays recoverable from the source PDF.
 */
export function parseUrheber(value: string): ParsedAsker[] {
  const askers: ParsedAsker[] = [];
  for (const chunk of value.split(";")) {
    const entry = chunk.trim();
    if (entry === "") continue;
    let party: string | undefined;
    let name = entry;

    const parenthesised = /^(.*?)\s*\(([^()]+)\)\s*$/.exec(entry);
    if (parenthesised) {
      name = (parenthesised[1] as string).trim();
      party = (parenthesised[2] as string).trim();
    } else {
      // `Surname, Given, Dr., CDU` — a trailing comma-separated party.
      const parts = entry.split(",").map((part) => part.trim());
      if (parts.length >= 3) {
        const last = parts[parts.length - 1] as string;
        if (/^[A-ZÄÖÜ][A-ZÄÖÜa-zäöüß.\-/ ]{1,28}$/.test(last) && !/^(Dr|Prof)\.?$/.test(last)) {
          party = last;
          parts.pop();
        }
      }
      name = parts.join(", ");
    }

    // A bare party name on its own (the aggregator repeats the Fraktion) is not a person.
    if (party === undefined && /^[A-ZÄÖÜ][A-ZÄÖÜ0-9/.\- ]{1,12}$/.test(name) && !name.includes(",")) {
      continue;
    }
    const normalised = normaliseName(name);
    if (normalised === "") continue;
    const asker: ParsedAsker = { name: normalised };
    if (party !== undefined && party !== "") asker.party = party;
    askers.push(asker);
  }
  return askers;
}

/** Academic and parliamentary titles, which German records print after the name. */
const TITLE = /^(?:Dr\.?(?:\s*h\.?\s*c\.?)?|Prof\.?|Dipl\.?-?\s*\w*\.?|MdB|MdL|MdA)$/i;

/**
 * `Otto, Andreas` -> `Andreas Otto`, and `Goldner, Antonia-Katharina, Dr.` ->
 * `Dr. Antonia-Katharina Goldner`. Titles move to the front, where a German reader
 * expects them; nothing is dropped, and the printed form stays in the source PDF.
 */
function normaliseName(name: string): string {
  const parts = name.split(",").map((part) => part.trim()).filter((part) => part !== "");
  if (parts.length < 2) return name.trim();
  const surname = parts[0] as string;
  const titles: string[] = [];
  const given: string[] = [];
  for (const part of parts.slice(1)) {
    (TITLE.test(part) ? titles : given).push(part);
  }
  return [...titles, ...given, surname].join(" ").replace(/\s+/g, " ").trim();
}

export interface DocumentMarkers {
  classified: boolean;
  contains_tables: boolean;
  attachments_referenced: string[];
}

const CLASSIFIED = /\b(?:VS[ -]?(?:NUR F(?:Ü|UE)R DEN DIENSTGEBRAUCH|VERTRAULICH)|VERSCHLUSSSACHE|GEHEIM(?:HALTUNG)?|NICHT ZUR VER(?:Ö|OE)FFENTLICHUNG)\b/i;

/**
 * Structural markers. `contains_tables` is a *hint*, not a claim about layout: a
 * text layer has no table objects, so the marker fires on the tabular typography a
 * text extraction leaves behind (several columns separated by runs of spaces) or on
 * an explicit reference to a Tabelle.
 */
export function findMarkers(text: string): DocumentMarkers {
  const attachments = new Set<string>();
  const pattern = /\bAnlage[n]?\s+((?:\d{1,2}|[IVXLC]{1,5})(?:\s*(?:,|und|bis|-|–)\s*(?:\d{1,2}|[IVXLC]{1,5}))*)/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    for (const part of (match[1] as string).split(/\s*(?:,|und|bis|-|–)\s*/)) {
      const token = part.trim();
      if (token !== "") attachments.add(`Anlage ${token}`);
    }
  }

  const columnar = text.split("\n").filter((line) => /\S {3,}\S.* {3,}\S/.test(line)).length;
  return {
    classified: CLASSIFIED.test(text),
    contains_tables: columnar >= 3 || /\bTabelle\b/.test(text),
    attachments_referenced: [...attachments].sort((a, b) =>
      a.localeCompare(b, "de", { numeric: true, sensitivity: "base" }),
    ),
  };
}

/** The Senatsverwaltung / Ministerium that signed an answer, if the text names one. */
export function findMinistry(text: string): string | undefined {
  const match =
    /^[ \t]*((?:Senatsverwaltung|Ministerium|Staatsministerium|Senator(?:in)?|Der Senat|Bundesministerium)[^\n]{0,120})$/im.exec(
      text,
    );
  if (match === null) return undefined;
  const line = (match[1] as string).trim().replace(/\s+/g, " ");
  return line === "" ? undefined : line;
}
