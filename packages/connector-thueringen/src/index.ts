// Thüringen: the Thüringer Landtag, whose Parlamentsdatenbank keeps the question
// and the answer in one Vorgang but publishes them as two unrelated Drucksachen.
//
// The answer's Drucksachennummer has no relation to the Kleine Anfrage's — 8/979 is
// answered by 8/1715 — and nothing in the question document names it; it is
// published weeks later.
//
// The Parlamentsspiegel does list it, as a follow-up document. This comment used to
// say it did not, which was an artefact of the aggregator parser splitting a result
// block on the `ps-folge` class: the portal emits that class only when the search
// filtered some of a Vorgang's follow-ups away, and every Thüringen row is
// unfiltered. Since that was fixed the row yields the answer's Parldok link, its
// date and the answering ministry, and the API below confirms the paper rather than
// being the only route to it.
//
// Parldok is a single-page application whose search runs over a JSON API. This
// adapter uses two of its endpoints, in the same way the application does:
//
//   Fulltext/Search   find the Kleine Anfrage by kind, number and Wahlperiode
//   Process/Document  list the Vorgang's positions, one of which is the answer
//
// That API is **undocumented**. It is the site's own public endpoint serving public
// documents, and asking it for JSON is gentler than scraping the rendered page, but
// nothing promises it will keep its shape. The adapter therefore treats every
// unexpected response as "no answer found" and says so, rather than failing the
// sync — and the Landtag publishing a documented interface would let all of this
// be deleted.

import type { Asker } from "@maschinenlesbar.org/openka-lib-models";
import { parseGermanDate } from "@maschinenlesbar.org/openka-lib-extract";
import { decodeEntities } from "@maschinenlesbar.org/openka-lib-source";
import { FallbackSource, type DiscoverOptions, type DiscoverResult, type DocRef, type DocRefDocument, type Source } from "@maschinenlesbar.org/openka-lib-source";
import { ParlamentsspiegelSource } from "@maschinenlesbar.org/openka-lib-parlamentsspiegel";
import type { SourceEntry } from "@maschinenlesbar.org/openka-lib-source";
import {
  FACET_KIND,
  FACET_LP,
  FACET_TIME,
  KIND_KLEINE_ANFRAGE,
  answerPosition,
  processBody,
  searchDocumentsBody,
  searchResults,
} from "@maschinenlesbar.org/openka-lib-parldok";
export * from "@maschinenlesbar.org/openka-lib-parldok";

/** The API host the Parldok application talks to. */
export const PARLDOK_API = "https://parldok.thltcloud.de/parldok";

/** The public host documents are served from. */
export const PARLDOK_WEB = "https://parldok.thueringer-landtag.de/ParlDok";

/** The Wahlperiode currently sitting; the default window when none is given. */
export const THUERINGEN_LATEST_PERIOD = 8;

/**
 * The Dokumentart id for a Kleine Anfrage, read from this installation's own facet
 * listing: `5`, with 21,738 documents. Thüringen files the question type under
 * `Dokumentart` (facet 7); Mecklenburg-Vorpommern files it under `Dokumenttyp`
 * (facet 8). The facet *ids* are software constants; the values are not.
 */
export const KIND_KLEINE_ANFRAGE_TH = KIND_KLEINE_ANFRAGE;

/** The Landtag's own Parlamentsdokumentation. */
export class ThueringenParldokSource implements Source {
  readonly key = "thueringen";
  readonly parliament = "thueringen" as const;
  readonly tier = "structured" as const;
  readonly label = "Thüringer Landtag (Parldok)";
  readonly homepage = "https://parldok.thueringer-landtag.de/ParlDok/";
  readonly notes =
    "Discovery and the answer lookup both run through the Landtag's own Parldok API. A listing " +
    "search returns the Kleine Anfragen of a window with the query id a Vorgang lookup needs, so " +
    "each answer costs one request rather than two. The answer is a Drucksache with no relation " +
    "to the question's number (8/979 is answered by 8/1715) and reprints the question above the " +
    "reply, so it is attached as a combined paper. The API is undocumented, so a response in an " +
    "unfamiliar shape is reported as unreadable rather than as an empty Land.";

  async discover(options: DiscoverOptions): Promise<DiscoverResult> {
    const warnings: string[] = [];
    const period = options.period ?? THUERINGEN_LATEST_PERIOD;
    const body = searchDocumentsBody({
      tags: [
        { type: FACET_KIND, id: KIND_KLEINE_ANFRAGE, label: "Kleine Anfrage" },
        { type: FACET_LP, id: period, label: String(period) },
        ...timeTags(options),
      ],
      length: options.limit ?? 200,
    });

    const response = await options.engine.post(`${PARLDOK_API}/Fulltext/Search`, {
      body: `data=${encodeURIComponent(body)}`,
      headers: { accept: "application/json" },
    });
    const reading = searchResults(response.body.toString("utf8"));
    if (reading.kind === "unrecognised") {
      return {
        refs: [],
        warnings,
        unreadable: `Parldok answered in a form this adapter does not know (${reading.reason})`,
      };
    }
    if (reading.kind === "absent") return { refs: [], warnings };

    const refs: DocRef[] = [];
    for (const doc of reading.value.docs) {
      const ref = toRef(doc, warnings);
      if (ref === undefined) continue;
      const answer = await this.findAnswer(doc, reading.value.queryId, ref.reference, options, warnings);
      if (answer === undefined) {
        refs.push(ref);
        continue;
      }
      // The answer Drucksache reprints the question above the reply, so it is a
      // combined paper; the Kleine Anfrage itself stays as the question source.
      const documents: DocRefDocument[] = [
        ...ref.documents,
        { role: "combined_pdf", url: answer.url, urlStable: true },
      ];
      refs.push({ ...ref, documents });
    }
    return { refs, warnings };
  }

  /**
   * The answer for one hit.
   *
   * The listing already carried the document id and the query id, so this is a
   * single `Process/Document` call — the per-ref search the aggregator path needed
   * is gone.
   */
  private async findAnswer(
    doc: Record<string, unknown>,
    queryId: number,
    reference: string,
    options: DiscoverOptions,
    warnings: string[],
  ): Promise<{ url: string; reference?: string } | undefined> {
    const id = typeof doc["id"] === "number" ? doc["id"] : undefined;
    if (id === undefined) return undefined;
    try {
      const process = await options.engine.post(`${PARLDOK_API}/Process/Document`, {
        body: `data=${encodeURIComponent(processBody(id, queryId))}`,
        headers: { accept: "application/json" },
      });
      const answer = answerPosition(process.body.toString("utf8"), PARLDOK_WEB);
      if (answer.kind === "unrecognised") {
        warnings.push(
          `${reference}: Parldok's Vorgang answered in a form this adapter does not know ` +
            `(${answer.reason}) — treated as no answer, but the API may have changed`,
        );
        return undefined;
      }
      // Not an error: an Anfrage nobody has answered yet looks exactly like this,
      // and the Vorgang says so in words — "Gedruckte Antwort liegt noch nicht vor".
      if (answer.kind === "absent") return undefined;
      return answer.value;
    } catch (err) {
      warnings.push(`${reference}: could not reach Parldok (${(err as Error).message})`);
      return undefined;
    }
  }
}

/** `since`/`until` become the same `datefrom`/`dateto` tags the search page sends. */
function timeTags(options: DiscoverOptions): { type: number; id: string; label: string; field: string }[] {
  const german = (iso: string): string => {
    const [year, month, day] = iso.split("-");
    return `${day}.${month}.${year}`;
  };
  const tags: { type: number; id: string; label: string; field: string }[] = [];
  if (options.since !== undefined) {
    tags.push({ type: FACET_TIME, id: german(options.since), label: german(options.since), field: "datefrom" });
  }
  if (options.until !== undefined) {
    tags.push({ type: FACET_TIME, id: german(options.until), label: german(options.until), field: "dateto" });
  }
  return tags;
}

/** One listing hit as a DocRef — the question paper, before its answer is attached. */
export function toRef(doc: Record<string, unknown>, warnings: string[]): DocRef | undefined {
  const number = typeof doc["number"] === "string" ? doc["number"] : undefined;
  const period = typeof doc["lp"] === "number" ? doc["lp"] : Number.NaN;
  const link = typeof doc["link"] === "string" ? doc["link"] : undefined;
  const id = typeof doc["id"] === "number" ? doc["id"] : undefined;
  if (number === undefined || id === undefined || link === undefined || !Number.isInteger(period) || period < 1) {
    warnings.push("Parldok returned a hit without a number, id, link or Wahlperiode; skipped");
    return undefined;
  }
  const submitted = typeof doc["date"] === "string" ? parseGermanDate(doc["date"]) : undefined;
  return {
    key: `parldok:${id}`,
    reference: `${period}/${number}`,
    legislative_period: period,
    title: typeof doc["title"] === "string" ? doc["title"] : "",
    documentType: "kleine_anfrage",
    askers: parseAuthors(typeof doc["authorhtml"] === "string" ? doc["authorhtml"] : ""),
    answered_by: {},
    // The listing's date is the question's own; the answer carries its own date.
    dates: submitted === undefined ? {} : { submitted },
    documents: [{ role: "question_pdf", url: `${PARLDOK_WEB}${link}`, urlStable: true }],
  };
}

/**
 * The askers of a question document.
 *
 * Thüringen's row names only the members — the government appears on the *answer*
 * document, not here — so this is simpler than Mecklenburg-Vorpommern's, which has
 * to keep the Landesregierung out of the asker list.
 */
export function parseAuthors(value: string): Asker[] {
  const askers: Asker[] = [];
  for (const entry of value.split(",")) {
    const trimmed = decodeEntities(entry.trim());
    if (trimmed === "") continue;
    const match = /^(.*?)\s*\(([^()]+)\)\s*$/.exec(trimmed);
    const name = (match?.[1] ?? trimmed).trim();
    if (name === "") continue;
    const asker: Asker = { name };
    const party = match?.[2]?.trim();
    if (party !== undefined && party !== "") asker.party = party;
    askers.push(asker);
  }
  return askers;
}

/**
 * What `createSource()` returns: the Landtag's own documentation, with the
 * Parlamentsspiegel behind it for the days the API is down or has moved.
 */
export function createSource(): Source {
  return new FallbackSource(new ThueringenParldokSource(), new ParlamentsspiegelSource("thueringen"));
}

/** How this connector announces itself to the registry and `ka sources list`. */
export const ENTRY: SourceEntry = {
  key: "thueringen",
  parliament: "thueringen",
  label: "Thüringer Landtag (Parldok)",
  status: "implemented",
  note: "the Landtag's own Parldok API for discovery and answers, with the Parlamentsspiegel as a fallback",
  factory: createSource,
};
