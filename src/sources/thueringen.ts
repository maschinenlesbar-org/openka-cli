// Thüringen: the Thüringer Landtag, whose Parlamentsdatenbank keeps the question
// and the answer in one Vorgang but publishes them as two unrelated Drucksachen.
//
// The Parlamentsspiegel knows an answer exists — its row says "1 weiteres Dokument"
// — and does not render it, so the aggregator alone yields question-only records.
// Nothing in the question document names the answer either; it is published weeks
// later under a Drucksachennummer with no relation to the Kleine Anfrage's (8/979
// is answered by 8/1715).
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

import { parseReference } from "../core/models/reference.js";
import { withDiscoveryState, type DiscoverOptions, type DiscoverResult, type DocRef, type DocRefDocument, type Source } from "./base.js";
import { ParlamentsspiegelSource } from "./parlamentsspiegel.js";

/** The API host the Parldok application talks to. */
export const PARLDOK_API = "https://parldok.thltcloud.de/parldok";

/** The public host documents are served from. */
export const PARLDOK_WEB = "https://parldok.thueringer-landtag.de/ParlDok";

/** Facet ids, read from the application's own `pd.facet_*` constants. */
export const FACET_KIND = 7;
export const FACET_LP = 10;
export const FACET_NUMBER = 14;

/** The document-kind id for a Kleine Anfrage, from the search form's options. */
export const KIND_KLEINE_ANFRAGE = "5";

/** Defaults the application sends; sending fewer makes the endpoint answer 500. */
const SEARCH_DEFAULTS = { max: 1000, withfilter: false, sort: 0, topk: 3, llm: 0, newdocsearch: false };

/** The body of a search for one Kleine Anfrage. */
export function searchBody(number: string, period: number): string {
  return JSON.stringify({
    devicekey: "",
    ...SEARCH_DEFAULTS,
    limit: { Length: 10 },
    tags: [
      { type: FACET_KIND, id: KIND_KLEINE_ANFRAGE, label: "Kleine Anfrage", ored: true },
      { type: FACET_NUMBER, id: number, label: number, ored: true },
      { type: FACET_LP, id: period, label: String(period), ored: true },
    ],
  });
}

/** The body asking for a document's Vorgang. */
export function processBody(documentId: number, queryId: number): string {
  return JSON.stringify({ devicekey: "", id: documentId, queryid: queryId });
}

/**
 * Responses wrap their payload as a JSON *string* under `data`. Returns `undefined`
 * for anything that is not the success shape, which is how an API that changed
 * under us becomes "no answer found" rather than a crash.
 */
export function successPayload(body: string): Record<string, unknown> | undefined {
  let outer: { success?: unknown; data?: unknown };
  try {
    outer = JSON.parse(body) as { success?: unknown; data?: unknown };
  } catch {
    return undefined;
  }
  if (outer.success !== true || typeof outer.data !== "string") return undefined;
  try {
    const inner = JSON.parse(outer.data) as unknown;
    return typeof inner === "object" && inner !== null ? (inner as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export interface FoundDocument {
  id: number;
  queryId: number;
}

/** The first hit of a search, with the query id its Vorgang lookup needs. */
export function firstHit(body: string): FoundDocument | undefined {
  const data = successPayload(body);
  if (data === undefined) return undefined;
  const docs = Array.isArray(data["docs"]) ? (data["docs"] as Record<string, unknown>[]) : [];
  const first = docs[0];
  const id = first?.["id"];
  const queryId = data["queryid"];
  if (typeof id !== "number" || typeof queryId !== "number") return undefined;
  return { id, queryId };
}

/**
 * The answer among a Vorgang's positions. Positions are labelled in prose — the
 * answer's reads "Antwort auf Kleine Anfrage <ministry>" — and carry the document's
 * own link, which is what gets fetched.
 */
export function answerPosition(body: string): { url: string; reference?: string } | undefined {
  const data = successPayload(body);
  const process = data?.["process"];
  if (typeof process !== "object" || process === null) return undefined;
  const positions = (process as Record<string, unknown>)["positions"];
  if (!Array.isArray(positions)) return undefined;

  for (const entry of positions as Record<string, unknown>[]) {
    const text = typeof entry["text"] === "string" ? entry["text"] : "";
    if (!/\bAntwort\b/i.test(text)) continue;
    const document = entry["doc"];
    if (typeof document !== "object" || document === null) continue;
    const link = (document as Record<string, unknown>)["prelink"] ?? (document as Record<string, unknown>)["link"];
    if (typeof link !== "string" || link === "") continue;
    const found: { url: string; reference?: string } = { url: `${PARLDOK_WEB}${link}` };
    // The slug carries the Drucksachennummer: `/dokument/103169/8_1715_personal…`.
    const match = /\/dokument\/\d+\/(\d{1,2})_0*(\d+)_/.exec(link);
    if (match !== null) found.reference = `${match[1]}/${match[2]}`;
    return found;
  }
  return undefined;
}

export class ThueringenSource implements Source {
  readonly key = "thueringen";
  readonly parliament = "thueringen" as const;
  readonly tier = "structured" as const;
  readonly label = "Thüringer Landtag (Parldok)";
  readonly homepage = "https://parldok.thueringer-landtag.de/ParlDok/";
  readonly notes =
    "Discovery runs through the Parlamentsspiegel, which knows an answer exists but does not render " +
    "it. The answer is a Drucksache with no relation to the Kleine Anfrage's number (8/979 is " +
    "answered by 8/1715), so it is looked up through Parldok's own JSON API — undocumented, so an " +
    "unexpected response means 'no answer found' rather than a failed sync. The answer document " +
    "holds the question and the reply together.";

  private readonly aggregator = new ParlamentsspiegelSource("thueringen");

  async discover(options: DiscoverOptions): Promise<DiscoverResult> {
    const discovered = await this.aggregator.discover(options);
    const warnings = [...discovered.warnings];
    const refs: DocRef[] = [];

    for (const ref of discovered.refs) {
      const answer = await this.findAnswer(ref, options, warnings);
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

    return withDiscoveryState(discovered, refs, warnings);
  }

  private async findAnswer(
    ref: DocRef,
    options: DiscoverOptions,
    warnings: string[],
  ): Promise<{ url: string; reference?: string } | undefined> {
    const number = parseReference(ref.reference)?.number ?? ref.reference;
    if (number === undefined || number === "") return undefined;
    try {
      const search = await options.engine.post(`${PARLDOK_API}/Fulltext/Search`, {
        body: `data=${encodeURIComponent(searchBody(String(Number(number)), ref.legislative_period))}`,
        headers: { accept: "application/json" },
      });
      const hit = firstHit(search.body.toString("utf8"));
      if (hit === undefined) {
        warnings.push(`${ref.reference}: Parldok found no Kleine Anfrage with that number`);
        return undefined;
      }
      const process = await options.engine.post(`${PARLDOK_API}/Process/Document`, {
        body: `data=${encodeURIComponent(processBody(hit.id, hit.queryId))}`,
        headers: { accept: "application/json" },
      });
      const answer = answerPosition(process.body.toString("utf8"));
      if (answer === undefined) {
        // Not an error: an Anfrage that has not been answered yet looks exactly
        // like this, and so does one whose answer Parldok has not published.
        return undefined;
      }
      return answer;
    } catch (err) {
      warnings.push(`${ref.reference}: could not reach Parldok (${(err as Error).message})`);
      return undefined;
    }
  }
}
