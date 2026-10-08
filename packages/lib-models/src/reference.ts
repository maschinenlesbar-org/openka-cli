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

/**
 * The numeric shape, spaces and tabs permitted where a cover page prints them, with
 * an optional `KA` in front. Sachsen-Anhalt numbers a Kleine Anfrage on its own
 * (`KA 8/3985`) apart from its Drucksachen (`8/3985`), and the two sequences overlap:
 * read alike, an unanswered question and an older answer of the same number shared one
 * record id, and one replaced the other (issue #22).
 */
const BODY = /^[ \t]*(?:(KA)[ \t]+)?(\d{1,2})[ \t]*\/[ \t]*((?:\d[\d \t]{0,10}\d|\d))[ \t]*$/;

/**
 * A Drucksachennummer, as printed.
 *
 * Both halves are strings, because the padding is part of how a Land writes it and
 * it is not ours to normalise: Thüringen's records carry `08/980` while the
 * document itself says `8/980`. An earlier version made `period` a number "because
 * leading zeros are part of how a Land prints it" — which was true, and then
 * dropped the zero from the only half that had one, so `formatReference` did not
 * round-trip. `periodNumber` is there for the callers that want to compare.
 */
export interface Reference {
  readonly period: string;
  readonly number: string;
  /** `KA` for a Kleine Anfrage's own number, in a Land that numbers them apart; absent for a Drucksache. */
  readonly prefix?: "KA";
}

/** The period as an integer, for comparing and filtering. */
export function periodNumber(reference: Reference): number {
  return Number.parseInt(reference.period, 10);
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
  const number = (match[3] as string).replace(/[ \t]+/g, "");
  if (number === "") return undefined;
  return { period: match[2] as string, number, ...(match[1] === "KA" ? { prefix: "KA" as const } : {}) };
}

/** The printed form, which is what a citation looks like. */
export function formatReference(reference: Reference): string {
  return `${reference.prefix === undefined ? "" : `${reference.prefix} `}${reference.period}/${reference.number}`;
}

/**
 * The part of a reference that goes into a record id.
 *
 * The period is *not* taken from here: `makeRecordId` is given the record's
 * `legislative_period`, which is authoritative, while the printed reference may
 * pad it (`08/980` under period 8). Changing this changes every record's identity.
 */
export function referenceSlug(reference: string): string {
  // A Kleine Anfrage's own number keeps its prefix, so `KA 8/3985` and Drucksache
  // `8/3985` — two different papers — do not share a record id.
  const prefix = /^[ \t]*KA[ \t]+\d/.test(reference) ? "ka-" : "";
  const tail = reference.includes("/") ? reference.slice(reference.indexOf("/") + 1) : reference;
  return prefix + tail
    .replace(/\s+/g, "")
    .replace(/[^0-9A-Za-z-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}
