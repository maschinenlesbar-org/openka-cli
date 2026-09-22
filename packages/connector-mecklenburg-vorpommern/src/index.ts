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
  searchDocumentsBody,
  searchResults,
  type ParldokEndpoint,
} from "@maschinenlesbar.org/openka-lib-parldok";
import type { Asker } from "@maschinenlesbar.org/openka-lib-models";

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

/** An entry naming the government rather than a member. */
const GOVERNMENT = /^(Landesregierung|Ministerium|Ministerin|Minister|Staatskanzlei|Präsident(in)?)\b/;

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

  async discover(options: DiscoverOptions): Promise<DiscoverResult> {
    const warnings: string[] = [];
    const period = options.period ?? MV_LATEST_PERIOD;
    const body = searchDocumentsBody({
      tags: [
        { type: FACET_KIND_MV, id: TYPE_KLEINE_ANFRAGE_UND_ANTWORT, label: "Kleine Anfrage und Antwort" },
        { type: FACET_LP, id: period, label: String(period) },
        ...timeTags(options),
      ],
      length: options.limit ?? 200,
    });

    const response = await options.engine.post(`${PARLDOK.api}/Fulltext/Search`, {
      body: `data=${encodeURIComponent(body)}`,
      headers: { accept: "application/json" },
    });
    const reading = searchResults(response.body.toString("utf8"));
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
    for (const doc of reading.value.docs) {
      const ref = toRef(doc, warnings);
      if (ref !== undefined) refs.push(ref);
    }
    return withDiscoveryState({ refs, warnings }, refs, warnings);
  }
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
  const { askers, ministry } = parseAuthors(typeof doc["authorhtml"] === "string" ? doc["authorhtml"] : "");
  const ref: DocRef = {
    key: `parldok:${id}`,
    reference: `${period}/${number}`,
    legislative_period: period,
    title: typeof doc["title"] === "string" ? doc["title"] : "",
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

/**
 * What `createSource()` returns: the Landtag's own documentation, with the
 * Parlamentsspiegel behind it for the days the API is down or has moved.
 */
export function createSource(): Source {
  return new FallbackSource(new MecklenburgVorpommernParldokSource(), new ParlamentsspiegelSource(PARLIAMENT));
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
