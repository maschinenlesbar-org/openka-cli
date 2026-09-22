// A Drucksachennummer, as a value rather than a string.
//
// `19/10006` is a period and a number, and the codebase used to take it apart
// wherever it needed one of the two — sixteen sites, each with its own idea of the
// grammar, including the same expression written twice in different files:
//
//   reference.includes("/") ? reference.slice(reference.indexOf("/") + 1) : reference
//   reference.includes("/") ? reference.split("/")[1] : reference
//
// That is what made the label fix in `findReference` awkward: the grammar had
// seven homes and only one of them could be taught about labels. It lives here now.

/** The numeric shape, spaces and tabs permitted where a cover page prints them. */
const BODY = /^[ \t]*(\d{1,2})[ \t]*\/[ \t]*((?:\d[\d \t]{0,10}\d|\d))[ \t]*$/;

/**
 * A Drucksachennummer.
 *
 * `number` stays a string because leading zeros are part of how a Land prints it:
 * Thüringen's records carry `08/980` while the document says `8/980`, and turning
 * that into `980` would lose which form the source used.
 */
export interface Reference {
  readonly period: number;
  readonly number: string;
}

/**
 * Parse a string that *is* a reference. Whole-string, the way `parseGermanDate` is
 * to `findDate`; `findReference` in `extract/metadata.ts` is the one that looks
 * inside running prose, and it needs a label to do so safely.
 *
 * The spaces Berlin's cover page inserts for legibility (`19 / 10 006`) are
 * removed from the numeric part.
 */
export function parseReference(value: string): Reference | undefined {
  const match = BODY.exec(value);
  if (match === null) return undefined;
  const number = (match[2] as string).replace(/[ \t]+/g, "");
  if (number === "") return undefined;
  return { period: Number(match[1]), number };
}

/** The printed form, which is what a citation looks like. */
export function formatReference(reference: Reference): string {
  return `${reference.period}/${reference.number}`;
}

/**
 * The part of a reference that goes into a record id.
 *
 * The period is *not* taken from here: `makeRecordId` is given the record's
 * `legislative_period`, which is authoritative, while the printed reference may
 * pad it (`08/980` under period 8). Changing this changes every record's identity.
 */
export function referenceSlug(reference: string): string {
  const tail = reference.includes("/") ? reference.slice(reference.indexOf("/") + 1) : reference;
  return tail
    .replace(/\s+/g, "")
    .replace(/[^0-9A-Za-z-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}
