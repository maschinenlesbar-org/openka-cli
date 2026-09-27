// Deterministic metadata rules over a document's plain text: German dates,
// Drucksachen references, askers, the answering ministry, and the document markers.
//
// Every function here returns `undefined` rather than a best guess when its pattern
// does not match. Callers turn that into an abstention.

import { isCalendarDate } from "@maschinenlesbar.org/openka-lib-models";
import { formatReference, parseReference, periodNumber } from "@maschinenlesbar.org/openka-lib-models";

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
/**
 * The offices this field names instead of a person. Schleswig-Holstein files the
 * question and the answer as one document, so its `Urheber` reads
 * "Dürbrook, Niclas (SPD); Sozialdemokratische Partei Deutschlands (SPD);
 * Minister/in für Wirtschaft, Verkehr, Arbeit, Technologie und Tourismus" — the
 * asker, their Fraktion, and the minister who answered, in one list.
 *
 * Read as people, the last of those became "Wissenschaft Minister/in für Allgemeine
 * und Berufliche Bildung" of the party "Forschung und Kultur": the comma rule for a
 * trailing party split a ministry's name in half and invented a party out of the
 * second half. An office is not a person and does not go in `askers`.
 */
// The lookahead matters: without it "Ministerowitsch, Anna (CDU)" is an office.
const OFFICE =
  /^(Ministerium|Ministerin|Minister|Senatsverwaltung|Senatorin|Senator|Staatssekretärin|Staatssekretär|Staatskanzlei|Landesregierung|Regierungspräsidium|Regierungspräsidentin|Regierungspräsident|Präsidentin|Präsident|Bürgermeisterin|Bürgermeister)(?![\p{L}])/u;

/** A Land's ministry spelled out with its Land in front, as Niedersachsen writes it. */
const LAND_OFFICE = /^\p{Lu}[\p{L}-]+(es|e|er)\s+(Ministerium|Staatskanzlei|Landesamt)/u;

/**
 * What stands in the party slot for a member of no Fraktion. It is written in lower
 * case, so the capitalised-party rule missed it and Hessen's "Herr, Sascha,
 * fraktionslos" became the person "Sascha fraktionslos Herr", with no party — and
 * `--party fraktionslos` could not find the record.
 */
const NO_FRAKTION = /^(?:fraktionslos|parteilos)$/i;

export interface ParsedUrheber {
  /** The people who asked. */
  askers: ParsedAsker[];
  /** Offices named in the same field — on a combined row, the answering body. */
  bodies: string[];
}

export function parseUrheber(value: string): ParsedUrheber {
  const askers: ParsedAsker[] = [];
  const bodies: string[] = [];
  for (const chunk of value.split(";")) {
    const entry = chunk.trim();
    if (entry === "") continue;
    if (OFFICE.test(entry) || LAND_OFFICE.test(entry)) {
      bodies.push(entry);
      continue;
    }
    let party: string | undefined;
    let name = entry;

    const parenthesised = /^(.*?)\s*\(([^()]+)\)\s*$/.exec(entry);
    if (parenthesised) {
      name = (parenthesised[1] as string).trim();
      party = (parenthesised[2] as string).trim();
      // Without a comma this is either a person written given name first, which is
      // how the portal prints Bayern ("Florian Köhler (AfD); Oskar Lipp (AfD)" —
      // 4,523 of 4,535 AfD rows lost every asker to the comma rule this replaced), or
      // the Fraktion spelled out beside its abbreviation, as Schleswig-Holstein
      // repeats it: "Sozialdemokratische Partei Deutschlands (SPD)". The name decides.
      if (!name.includes(",") && !isPersonName(name)) continue;
    } else {
      // `Surname, Given, Dr., CDU` — a trailing comma-separated party.
      const parts = entry.split(",").map((part) => part.trim());
      if (parts.length >= 3) {
        const last = parts[parts.length - 1] as string;
        if (
          (/^[A-ZÄÖÜ][A-ZÄÖÜa-zäöüß.\-/ ]{1,28}$/.test(last) || NO_FRAKTION.test(last)) &&
          !/^(Dr|Prof)\.?$/.test(last)
        ) {
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
  return { askers, bodies };
}

/**
 * Words that make a name an organisation. They are the words the Fraktionen's full
 * names are built from ("Freie Demokratische Partei", "Christlich Demokratische
 * Union Deutschlands", "Alternative für Deutschland", "Südschleswigscher
 * Wählerverband"); no person in these rows carries one.
 */
const ORGANISATION_WORD =
  /(?:^|\s)(?:Partei|Union|Bündnis|BÜNDNIS|Alternative|Wählerverband|Wählergemeinschaft|Fraktion|Gruppe|Linke|LINKE|Grüne|GRÜNE|Deutschlands)(?:\s|$)/u;

/** Name particles a German or Dutch surname may carry in lower case. */
const NAME_PARTICLE = /^(?:von|van|de|der|den|zu|vom|zum|ter)$/;

/**
 * A person written given name first: two to six words, each capitalised, a title
 * (`Dr.`, `Prof.`) or a name particle — "Florian Köhler", "Dr. Ute Eiling-Hütig",
 * "Ulrich von Zons". A number or a lower-case word that is not a particle ("für" in
 * "Alternative für Deutschland") rules it out, and so does an organisation word.
 */
function isPersonName(name: string): boolean {
  if (ORGANISATION_WORD.test(name)) return false;
  const words = name.split(/\s+/).filter((word) => word !== "");
  if (words.length < 2 || words.length > 6) return false;
  return words.every(
    (word) => TITLE.test(word) || NAME_PARTICLE.test(word) || /^\p{Lu}[\p{Ll}'’-]*(?:-\p{Lu}[\p{Ll}'’-]*)*\.?$/u.test(word),
  );
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
 * What an attachment is numbered with: one or two digits, or an upper-case Roman
 * numeral — ending where the word ends.
 *
 * The pattern used to be case-insensitive with no end, so "die PV-Anlage in
 * Betrieb" referenced "Anlage i", "Anlage liefert" "Anlage li" and "Anlage
 * verbraucht" "Anlage v" — attachments invented out of ordinary words, and frozen
 * into two goldens. Roman numerals are upper case when they number something, and
 * "Anlage 123" is not Anlage 12, nor "Anlage 1a" Anlage 1.
 */
const ATTACHMENT_NUMBER = String.raw`(?:\d{1,2}|[IVXLC]{1,5})(?![\p{L}\p{N}])`;

/**
 * Structural markers. `contains_tables` is a *hint*, not a claim about layout: a
 * text layer has no table objects, so the marker fires on the tabular typography a
 * text extraction leaves behind (several columns separated by runs of spaces) or on
 * an explicit reference to a Tabelle.
 */
export function findMarkers(text: string): DocumentMarkers {
  const attachments = new Set<string>();
  const pattern = new RegExp(
    String.raw`\b(?:Anlagen?|ANLAGEN?)\s+(${ATTACHMENT_NUMBER}(?:\s*(?:,|und|bis|-|–)\s*${ATTACHMENT_NUMBER})*)`,
    "gu",
  );
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

/**
 * A letterhead line naming the answering body: the office, then `für`/`des`/`der`
 * and its portfolio ("Senatsverwaltung für Inneres und Sport", "Bundesministerium
 * der Verteidigung"), or the Senat itself. A sentence that merely starts with
 * "Ministerium" ("Ministerium ist der Auffassung, dass …") is not one.
 */
const MINISTRY_LINE =
  /^[ \t]*((?:(?:Senatsverwaltung|Staatsministerium|Bundesministerium|Ministerium|Senator(?:in)?)[ \t]+(?:für|des|der)(?![\p{L}])|Der Senat(?:[ \t]+(?:von|der)(?![\p{L}]))?)[^\n]{0,120})$/imu;

/** A letterhead line that stops here is not finished: the portfolio goes on below. */
const UNFINISHED = /(?:[ \t](?:für|des|der|die|und|von|zur|zum|im|in|sowie)|,)$/i;

/** A portfolio has no finite verb; "Der Senat von Berlin hat beschlossen, dass" is a sentence. */
const SENTENCE_VERB = /(?<![\p{L}])(?:ist|sind|hat|haben|wird|werden|wurde|wurden|teilt|teilte)(?![\p{L}])/iu;

/** How many lines a wrapped letterhead may continue over. */
const MAX_MINISTRY_CONTINUATIONS = 2;

/**
 * The Senatsverwaltung / Ministerium that signed an answer, if the text names one.
 *
 * Berlin's letterhead wraps the name — "Senatsverwaltung für" on one line, "Umwelt,
 * Verkehr und Klimaschutz" on the next — and reading one line stored
 * "Senatsverwaltung für" with `review_status: ok`. A line that ends in a
 * preposition, an article, a conjunction or a comma is joined with the next; if
 * the name is still unfinished after that, or ends in a sentence's punctuation or a
 * hyphenation, nothing is returned and the caller abstains.
 */
export function findMinistry(text: string): string | undefined {
  const match = MINISTRY_LINE.exec(text);
  if (match === null) return undefined;
  let name = (match[1] as string).trim().replace(/\s+/g, " ");
  const following = text.slice(match.index + match[0].length).split("\n").slice(1);
  for (let i = 0; i < MAX_MINISTRY_CONTINUATIONS && UNFINISHED.test(name); i++) {
    const next = (following[i] ?? "").trim().replace(/\s+/g, " ");
    if (next === "") return undefined;
    name = `${name} ${next}`;
  }
  if (UNFINISHED.test(name) || /[.?!:;\-–]$/.test(name) || SENTENCE_VERB.test(name)) return undefined;
  return name;
}
