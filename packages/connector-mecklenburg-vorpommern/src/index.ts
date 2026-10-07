// Mecklenburg-Vorpommern: the Landtag's own Parlamentsdokumentation, which is a
// Parldok installation — the same software Thüringen runs, so the client is shared
// (`lib-parldok`) and only the two hosts differ.
//
// MV publishes the question and the answer as **one** Drucksache, filed under the
// Dokumenttyp "Kleine Anfrage und Antwort" (14,431 of them as of 2026, against
// 4,149 filed as "Kleine Anfrage" alone). That combined paper is what this adapter
// discovers, and its role is therefore `combined_pdf`.
//
// Three things make this a better source than the aggregator, which is why it is
// the primary and the Parlamentsspiegel is only the fallback:
//
//   * the result row carries the answering ministry, the asker and their Fraktion
//     as structured fields rather than as a sentence to be parsed out of prose;
//   * `/parldok/dokument/<id>` serves the PDF directly — no viewer, no wrapper,
//     no constructed URL;
//   * the date window is a server-side filter, so a sync fetches the window it
//     asked for instead of everything and discarding.
//
// The API is **undocumented** — see `lib-parldok` for what that costs and how it is
// handled. `https://www.dokumentation.landtag-mv.de/robots.txt` is a 404, so
// nothing here is disallowed; the requests this makes are the ones the site's own
// search page makes.

import { parseGermanDate } from "@maschinenlesbar.org/openka-lib-extract";
import {
  FallbackSource,
  textOf,
  withDiscoveryState,
  type DiscoverOptions,
  type DiscoverResult,
  type DocRef,
  type Source,
  type SourceEntry,
} from "@maschinenlesbar.org/openka-lib-source";
import { ParlamentsspiegelSource } from "@maschinenlesbar.org/openka-lib-parlamentsspiegel";
import {
  FACET_KIND_MV,
  FACET_LP,
  FACET_TIME,
  searchDocuments,
  type ParldokEndpoint,
} from "@maschinenlesbar.org/openka-lib-parldok";
import type { Asker, KaRecord } from "@maschinenlesbar.org/openka-lib-models";

export const PARLIAMENT = "mecklenburg-vorpommern" as const;
export const LABEL = "Landtag Mecklenburg-Vorpommern";

/** MV runs its Parldok on one host: the API and the documents share an origin. */
export const PARLDOK: ParldokEndpoint = {
  api: "https://www.dokumentation.landtag-mv.de/parldok",
  web: "https://www.dokumentation.landtag-mv.de/parldok",
};

/**
 * The Dokumenttyp id for the combined paper, read from the installation's own
 * `Dokumenttyp` facet rather than guessed: `136` is "Kleine Anfrage und Antwort".
 * `44` is "Kleine Anfrage" on its own — the unanswered ones — and is deliberately
 * not discovered here, because a record built from it would have no answer and the
 * combined paper supersedes it a few weeks later anyway.
 */
export const TYPE_KLEINE_ANFRAGE_UND_ANTWORT = "136";

/** The Wahlperiode currently sitting; the default window when none is given. */
export const MV_LATEST_PERIOD = 8;

/**
 * Split on the commas that separate entries, not on the ones inside a name.
 *
 * "Beate Schlupp (CDU), Landesregierung (Ministerium für Klimaschutz,
 * Landwirtschaft, ländliche Räume und Umwelt)" is two entries, and three of its
 * four commas belong to the ministry.
 */
export function splitAuthors(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === "," && depth === 0) {
      parts.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts.filter((part) => part !== "");
}

/**
 * An entry naming the government rather than a member. "Ministerpräsident(in)" comes
 * before "Minister": `Minister\b` does not match inside the longer word, and the head
 * of government was read as a second person who asked.
 */
const GOVERNMENT = /^(Landesregierung|Ministerium|Ministerpräsident(in)?|Ministerin|Minister|Staatskanzlei|Präsident(in)?)\b/;

export interface ParsedAuthors {
  askers: Asker[];
  /** The answering body, as the row names it. */
  ministry?: string;
}

/**
 * MV's `authorhtml` names everyone involved: the members who asked, with their
 * Fraktion, and the government, with the ressort that answered.
 *
 * "Landesregierung (Ministerium für Inneres und Bau)" is not a person, and reading
 * it as one is the mistake Schleswig-Holstein's row once produced — an invented
 * political party made out of half a ministry's name. The parenthesised part of a
 * government entry is the answering body; of a member entry, their Fraktion.
 */
export function parseAuthors(value: string): ParsedAuthors {
  const askers: Asker[] = [];
  let ministry: string | undefined;
  for (const entry of splitAuthors(value)) {
    const match = /^(.*?)\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*$/.exec(entry);
    const name = (match?.[1] ?? entry).trim();
    const qualifier = match?.[2]?.trim();
    if (GOVERNMENT.test(name)) {
      // "Landesregierung (Staatskanzlei)" answers from the Staatskanzlei; with no
      // ressort named, the government itself is as precise as the row gets.
      if (ministry === undefined) ministry = qualifier !== undefined && qualifier !== "" ? qualifier : name;
      continue;
    }
    if (name === "") continue;
    const asker: Asker = { name };
    if (qualifier !== undefined && qualifier !== "") asker.party = qualifier;
    askers.push(asker);
  }
  const parsed: ParsedAuthors = { askers };
  if (ministry !== undefined) parsed.ministry = ministry;
  return parsed;
}

/** The Landtag's own Parlamentsdokumentation. */
export class MecklenburgVorpommernParldokSource implements Source {
  readonly key = PARLIAMENT;
  readonly parliament = PARLIAMENT;
  readonly tier = "text_layer" as const;
  readonly label = `${LABEL} (Parlamentsdokumentation)`;
  readonly homepage = "https://www.dokumentation.landtag-mv.de/parldok/";
  readonly notes =
    "The Landtag's own Parldok installation. Question and answer are one Drucksache — the " +
    "Dokumenttyp 'Kleine Anfrage und Antwort' — so a record needs exactly one document, and the " +
    "result row already carries the asker, the Fraktion and the answering ministry. The JSON " +
    "API is undocumented, so a response in an unfamiliar shape is reported as unreadable rather " +
    "than as an empty Land.";

  checkRecord(ref: DocRef, record: KaRecord): string | undefined {
    return checkRecord(ref, record);
  }

  async discover(options: DiscoverOptions): Promise<DiscoverResult> {
    const warnings: string[] = [];
    const period = options.period ?? MV_LATEST_PERIOD;
    const reading = await searchDocuments(options.engine, PARLDOK.api, {
      tags: [
        { type: FACET_KIND_MV, id: TYPE_KLEINE_ANFRAGE_UND_ANTWORT, label: "Kleine Anfrage und Antwort" },
        { type: FACET_LP, id: period, label: String(period) },
        ...timeTags(options),
      ],
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    });
    if (reading.kind === "unrecognised") {
      // Not an empty Land: the API answered in a shape this adapter does not know,
      // which is exactly the case a fallback exists for.
      return {
        refs: [],
        warnings,
        unreadable: `Parldok answered in a form this adapter does not know (${reading.reason})`,
      };
    }
    if (reading.kind === "absent") return withDiscoveryState({ refs: [], warnings }, [], warnings);

    const refs: DocRef[] = [];
    const byReference = new Map<string, DocRef>();
    let skipped = 0;
    let foreign = 0;
    for (const { doc } of reading.value) {
      // The type and period filters run on the server of an undocumented API; a row
      // that says it is something else (type 44, the unanswered "Kleine Anfrage", a
      // Protokoll, another Wahlperiode) is not stored as what was asked for.
      if (isForeign(doc, period)) {
        foreign += 1;
        continue;
      }
      const ref = toRef(doc, []);
      if (ref === undefined) {
        skipped += 1;
        continue;
      }
      // One number, two documents (a reprint?) is one record id: both used to be
      // fetched and the second silently replaced the first. Which one is right is not
      // for this adapter to guess, so the first stays and the warning names both.
      const earlier = byReference.get(ref.reference);
      if (earlier !== undefined) {
        warnings.push(
          `Parldok listed Drucksache ${ref.reference} twice (documents ${documentId(earlier)} and ${documentId(ref)}); kept the first`,
        );
        continue;
      }
      byReference.set(ref.reference, ref);
      refs.push(ref);
    }
    const hits = reading.value.length;
    if (foreign === hits) {
      return {
        refs: [],
        warnings,
        unreadable: `Parldok answered ${hits} hit(s), none of them a "Kleine Anfrage und Antwort" of Wahlperiode ${period}: its search filter no longer means what this adapter sends`,
      };
    }
    if (foreign > 0) warnings.push(`Parldok returned ${foreign} of ${hits} hit(s) of another Dokumenttyp or Wahlperiode than asked for; skipped`);
    if (refs.length === 0) {
      // Hits that all lack what a record needs are not an empty Land: the rows changed
      // shape (a number sent as a number, an id renamed). Counting it as a found page
      // with nothing on it ended a sync as a successful empty one, with no fallback.
      return {
        refs: [],
        warnings,
        unreadable: `Parldok answered ${hits} hit(s), none of which carries a number, id and Wahlperiode in the form this adapter reads`,
      };
    }
    if (skipped > 0) warnings.push(`Parldok returned ${skipped} of ${hits} hit(s) without a number, id or Wahlperiode; skipped`);
    return withDiscoveryState({ refs, warnings }, refs, warnings);
  }
}

/** The Parldok document id at the end of a ref's document URL. */
function documentId(ref: DocRef): string {
  return ref.documents[0]?.url.split("/").pop() ?? "?";
}

/** A hit that names a type or Wahlperiode other than the ones asked for. Absent fields are not held against it. */
function isForeign(doc: Record<string, unknown>, period: number): boolean {
  const typeid = doc["typeid"];
  const lp = doc["lp"];
  return (typeof typeid === "number" && String(typeid) !== TYPE_KLEINE_ANFRAGE_UND_ANTWORT) || (typeof lp === "number" && lp !== period);
}

/**
 * Whether a record's text is the paper its row names. Every MV paper opens with
 * "LANDTAG MECKLENBURG-VORPOMMERN Drucksache 8/6344"; the row and the PDF are joined
 * only by the document id, and a row for 8/6809 served the PDF of 8/6344 used to be
 * stored as 8/6809 with 6344's text. A head that names another Drucksache, or another
 * Landtag, is a reason; no text, or a head that names neither, is not.
 */
export function checkRecord(ref: Pick<DocRef, "reference">, record: Pick<KaRecord, "full_text">): string | undefined {
  const lines = (record.full_text ?? "").split("\n").map((line) => line.trim()).filter((line) => line !== "").slice(0, 3);
  if (lines.length === 0) return undefined;
  const head = lines.join(" ");
  const printed = /Drucksache\s+(\d{1,2})\s*\/\s*(\d+)/.exec(head);
  if (printed !== null) {
    const [period, number] = ref.reference.split("/").map((part) => String(Number(part)));
    if (`${Number(printed[1])}/${Number(printed[2])}` !== `${period}/${number}`) {
      return `the document is Drucksache ${Number(printed[1])}/${Number(printed[2])}, not ${ref.reference}`;
    }
    return undefined;
  }
  if (/landtag/i.test(head) && !/mecklenburg-vorpommern/i.test(head)) {
    return `the document is not a paper of the Landtag Mecklenburg-Vorpommern (its head reads "${lines[0]}")`;
  }
  return undefined;
}

/** `since`/`until` become the same `datefrom`/`dateto` tags the search page sends. */
function timeTags(options: DiscoverOptions): { type: number; id: string; label: string; field: string }[] {
  const tags: { type: number; id: string; label: string; field: string }[] = [];
  const german = (iso: string): string => {
    const [year, month, day] = iso.split("-");
    return `${day}.${month}.${year}`;
  };
  if (options.since !== undefined) {
    tags.push({ type: FACET_TIME, id: german(options.since), label: german(options.since), field: "datefrom" });
  }
  if (options.until !== undefined) {
    tags.push({ type: FACET_TIME, id: german(options.until), label: german(options.until), field: "dateto" });
  }
  return tags;
}

/** One search hit as a DocRef, or `undefined` when it lacks an identity. */
export function toRef(doc: Record<string, unknown>, warnings: string[]): DocRef | undefined {
  const number = typeof doc["number"] === "string" ? doc["number"] : undefined;
  const period = typeof doc["lp"] === "number" ? doc["lp"] : Number.NaN;
  const id = typeof doc["id"] === "number" ? doc["id"] : undefined;
  if (number === undefined || id === undefined || !Number.isInteger(period) || period < 1) {
    warnings.push(`Parldok returned a hit without a number, id or Wahlperiode; skipped`);
    return undefined;
  }
  // Both fields are scraped text like any other and are cleaned the same way
  // (`textOf`: tags, entities, control characters, runs of whitespace). A title with
  // Word's line break, U+000B, used to fail the whole record.
  const { askers, ministry } = parseAuthors(typeof doc["authorhtml"] === "string" ? textOf(doc["authorhtml"]) : "");
  const ref: DocRef = {
    key: `parldok:${id}`,
    reference: `${period}/${number}`,
    legislative_period: period,
    title: typeof doc["title"] === "string" ? textOf(doc["title"]) : "",
    documentType: "kleine_anfrage",
    askers,
    answered_by: ministry === undefined ? {} : { ministry },
    // The combined paper's date is the date the *answer* was published; the
    // question's own date is inside the document, not in this row.
    dates: dateOf(doc),
    documents: [
      { role: "combined_pdf", url: `${PARLDOK.web}/dokument/${id}`, urlStable: true },
    ],
  };
  return ref;
}

function dateOf(doc: Record<string, unknown>): { answered?: string } {
  const raw = typeof doc["date"] === "string" ? doc["date"] : undefined;
  const iso = raw === undefined ? undefined : parseGermanDate(raw);
  return iso === undefined ? {} : { answered: iso };
}

/** The Landtag's document host, as the Parlamentsspiegel links it: plain http. */
const AGGREGATOR_LINK = /^http:\/\/www\.dokumentation\.landtag-mv\.de\//;

/**
 * A ref the Parlamentsspiegel found, made to fetch like one Parldok found. The
 * aggregator links the Landtag's documents over plain http, and the bytes archived as
 * evidence were fetched in cleartext; the same address answers over https (with a
 * redirect to `/parldok/dokument/<id>`, checked 2026-10-07), as the Parldok path does.
 */
export function fromAggregator(ref: DocRef): DocRef {
  return {
    ...ref,
    documents: ref.documents.map((document) => ({
      ...document,
      url: document.url.replace(AGGREGATOR_LINK, "https://www.dokumentation.landtag-mv.de/"),
    })),
  };
}

/** The Parlamentsspiegel for MV, with its refs made to fetch like Parldok's (`fromAggregator`). */
class MecklenburgVorpommernAggregatorSource extends ParlamentsspiegelSource {
  constructor() {
    super(PARLIAMENT);
  }

  override async discover(options: DiscoverOptions): Promise<DiscoverResult> {
    const result = await super.discover(options);
    return { ...result, refs: result.refs.map(fromAggregator) };
  }
}

/**
 * What `createSource()` returns: the Landtag's own documentation, with the
 * Parlamentsspiegel behind it for the days the API is down or has moved.
 */
export function createSource(): Source {
  return new FallbackSource(new MecklenburgVorpommernParldokSource(), new MecklenburgVorpommernAggregatorSource());
}

/** How this connector announces itself to the registry and `ka sources list`. */
export const ENTRY: SourceEntry = {
  key: PARLIAMENT,
  parliament: PARLIAMENT,
  label: LABEL,
  status: "implemented",
  note: "the Landtag's own Parldok API, with the Parlamentsspiegel as a fallback",
  factory: createSource,
};
