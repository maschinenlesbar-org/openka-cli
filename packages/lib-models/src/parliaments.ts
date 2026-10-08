// The 17 parliaments OpenKA covers: the Bundestag plus the 16 Landtage.
//
// Each entry carries the stable key used in record ids (`<parliament>-<period>-<ref>`),
// the German label, and the Herkunft code the Parlamentsspiegel export format
// (`Parlamentsspiegel Export 1.0` DTD, `<DHerk>`) uses for that parliament. The
// codes are taken from the Parlamentsspiegel search form's `qyHerk` values and the
// `<DHerk>` elements of the PARDOK export, not invented.

import type { DocumentType } from "./schema.js";

/** Stable parliament keys. Used verbatim in record ids and on the CLI. */
export const ParliamentKeys = [
  "bund",
  "baden-wuerttemberg",
  "bayern",
  "berlin",
  "brandenburg",
  "bremen",
  "hamburg",
  "hessen",
  "mecklenburg-vorpommern",
  "niedersachsen",
  "nordrhein-westfalen",
  "rheinland-pfalz",
  "saarland",
  "sachsen",
  "sachsen-anhalt",
  "schleswig-holstein",
  "thueringen",
] as const;

export type ParliamentKey = (typeof ParliamentKeys)[number];

export interface Parliament {
  key: ParliamentKey;
  label: string;
  /**
   * Herkunft code in the Parlamentsspiegel export/search (`<DHerk>` / `qyHerk`).
   * `undefined` for the Bundestag, which does not deliver to the Parlamentsspiegel.
   */
  herkunft?: string;
  /** What the parliament calls the instrument this project collects. */
  instrument: string;
  /**
   * Which of the schema's document types that instrument is.
   *
   * A property of the parliament's rules of procedure, not of any one document:
   * Bayern and Berlin call the same instrument a Schriftliche Anfrage, and
   * Hamburg's "Schriftliche Kleine Anfrage" is a Kleine Anfrage in writing. It is
   * declared here, beside the name it is derived from, so the two cannot disagree
   * — an adapter used to carry its own two-Land conditional instead.
   */
  documentType: DocumentType;
  /**
   * Fields this parliament's publications never carry, so a record abstains on them
   * however well it is read. They stay in `abstained_fields` — the record does not
   * pretend to know — but `ka review` and `ka stats` count a record whose only holes
   * are these apart from one the extractor could not read (issue #22).
   */
  knownGaps?: readonly KnownGap[];
}

/** A field a parliament never provides, and why. */
export interface KnownGap {
  /** The field kind as `abstained_fields` names it, indices dropped: `dates.submitted`. */
  field: string;
  reason: string;
}

/** Every parliament, in the order of `ParliamentKeys`. */
export const PARLIAMENTS: readonly Parliament[] = [
  { key: "bund", label: "Deutscher Bundestag", instrument: "Kleine Anfrage", documentType: "kleine_anfrage" },
  { key: "baden-wuerttemberg", label: "Landtag Baden-Württemberg", herkunft: "BW", instrument: "Kleine Anfrage", documentType: "kleine_anfrage" },
  { key: "bayern", label: "Bayerischer Landtag", herkunft: "BAY", instrument: "Schriftliche Anfrage", documentType: "schriftliche_anfrage" },
  { key: "berlin", label: "Abgeordnetenhaus von Berlin", herkunft: "BLN", instrument: "Schriftliche Anfrage", documentType: "schriftliche_anfrage" },
  { key: "brandenburg", label: "Landtag Brandenburg", herkunft: "BRA", instrument: "Kleine Anfrage", documentType: "kleine_anfrage" },
  { key: "bremen", label: "Bremische Bürgerschaft", herkunft: "HB", instrument: "Kleine Anfrage", documentType: "kleine_anfrage" },
  { key: "hamburg", label: "Hamburgische Bürgerschaft", herkunft: "HH", instrument: "Schriftliche Kleine Anfrage", documentType: "kleine_anfrage" },
  { key: "hessen", label: "Hessischer Landtag", herkunft: "HES", instrument: "Kleine Anfrage", documentType: "kleine_anfrage" },
  { key: "mecklenburg-vorpommern", label: "Landtag Mecklenburg-Vorpommern", herkunft: "MEVO", instrument: "Kleine Anfrage", documentType: "kleine_anfrage" },
  { key: "niedersachsen", label: "Niedersächsischer Landtag", herkunft: "NDS", instrument: "Kleine Anfrage", documentType: "kleine_anfrage" },
  { key: "nordrhein-westfalen", label: "Landtag Nordrhein-Westfalen", herkunft: "NW", instrument: "Kleine Anfrage", documentType: "kleine_anfrage" },
  { key: "rheinland-pfalz", label: "Landtag Rheinland-Pfalz", herkunft: "RPF", instrument: "Kleine Anfrage", documentType: "kleine_anfrage" },
  { key: "saarland", label: "Landtag des Saarlandes", herkunft: "SAL", instrument: "Kleine Anfrage", documentType: "kleine_anfrage" },
  { key: "sachsen", label: "Sächsischer Landtag", herkunft: "SAC", instrument: "Kleine Anfrage", documentType: "kleine_anfrage" },
  {
    key: "sachsen-anhalt",
    label: "Landtag von Sachsen-Anhalt",
    herkunft: "SACA",
    instrument: "Kleine Anfrage",
    documentType: "kleine_anfrage",
    // Measured on the live portal (2026-10-08): none of 50 answered rows of 2025 names
    // the question's date — the two dates a row sometimes prints are the paper's and
    // its Nachtrag's — and the issue's reporter found it in about 1.5% of the papers.
    knownGaps: [
      {
        field: "dates.submitted",
        reason:
          "question and answer are published as one Drucksache, dated by the answer; neither the Parlamentsspiegel " +
          "row nor, but for about 1.5%, the paper names the question's date",
      },
    ],
  },
  { key: "schleswig-holstein", label: "Schleswig-Holsteinischer Landtag", herkunft: "SH", instrument: "Kleine Anfrage", documentType: "kleine_anfrage" },
  { key: "thueringen", label: "Thüringer Landtag", herkunft: "THUE", instrument: "Kleine Anfrage", documentType: "kleine_anfrage" },
];

const BY_KEY = new Map<string, Parliament>(PARLIAMENTS.map((p) => [p.key, p]));
const BY_HERKUNFT = new Map<string, Parliament>(
  PARLIAMENTS.filter((p) => p.herkunft !== undefined).map((p) => [p.herkunft as string, p]),
);

/** The fields `parliament` never provides (`Parliament.knownGaps`); none for an unknown key. */
export function knownGaps(parliament: string): readonly KnownGap[] {
  return BY_KEY.get(parliament)?.knownGaps ?? [];
}

/** True when `fieldKind` (`dates.submitted`, `qa[].answer`) is one `parliament` never provides. */
export function isKnownGap(parliament: string, fieldKind: string): boolean {
  return knownGaps(parliament).some((gap) => gap.field === fieldKind);
}

/**
 * True when every hole a record has (its abstained field kinds, with counts — a
 * catalog row's `abstained_fields`) is one its parliament never provides: nothing the
 * extractor could have read is missing. False without holes, and for `undefined`
 * (a row catalogued before the kinds were indexed: unknown, so not left out).
 */
export function onlyKnownGaps(parliament: string, fieldKinds: Readonly<Record<string, number>> | undefined): boolean {
  if (fieldKinds === undefined) return false;
  const kinds = Object.keys(fieldKinds);
  return kinds.length > 0 && kinds.every((kind) => isKnownGap(parliament, kind));
}

/** Look a parliament up by its key, or `undefined` if the key is unknown. */
export function parliamentByKey(key: string): Parliament | undefined {
  return BY_KEY.get(key);
}

/** Look a parliament up by its Parlamentsspiegel Herkunft code (`BLN`, `HH`, ...). */
export function parliamentByHerkunft(code: string): Parliament | undefined {
  return BY_HERKUNFT.get(code.trim().toUpperCase());
}

/** True when `value` is one of the 17 known parliament keys. */
export function isParliamentKey(value: string): value is ParliamentKey {
  return BY_KEY.has(value);
}

/** The canonical form of a parliament key a caller typed: trimmed, lower case. */
export function normalizeParliamentKey(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Why `value` names no parliament, or `undefined` when it names one (in any case,
 * with any padding — `normalizeParliamentKey` folds it). An unknown key used to
 * filter everything away and read as "No matches."
 */
export function parliamentKeyProblem(value: string): string | undefined {
  return isParliamentKey(normalizeParliamentKey(value))
    ? undefined
    : `Unknown parliament "${value}". Known: ${ParliamentKeys.join(", ")}.`;
}
