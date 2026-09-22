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

import { parseReference } from "@maschinenlesbar.org/openka-lib-models";
import { withDiscoveryState, type DiscoverOptions, type DiscoverResult, type DocRef, type DocRefDocument, type Source } from "@maschinenlesbar.org/openka-lib-source";
import { ParlamentsspiegelSource } from "@maschinenlesbar.org/openka-lib-parlamentsspiegel";
import type { SourceEntry } from "@maschinenlesbar.org/openka-lib-source";

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
 * What a read of an undocumented response amounts to.
 *
 * `absent` and `unrecognised` both end a lookup with no answer, and both are
 * non-fatal, but they are different facts about the world: one says Parldok has
 * nothing, the other says Parldok said something we do not understand. Collapsing
 * them into `undefined` meant a schema change downstream looked exactly like a
 * Kleine Anfrage nobody had answered yet, and nothing in the sync said otherwise.
 */
export type ApiReading<T> =
  | { kind: "found"; value: T }
  | { kind: "absent" }
  | { kind: "unrecognised"; reason: string };

/**
 * Responses wrap their payload as a JSON *string* under `data`. Returns `undefined`
 * for anything that is not the success shape — always a shape we do not recognise,
 * never an empty result, which the callers distinguish.
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
export function firstHit(body: string): ApiReading<FoundDocument> {
  const data = successPayload(body);
  if (data === undefined) return { kind: "unrecognised", reason: "not a Parldok success envelope" };
  if (!Array.isArray(data["docs"])) return { kind: "unrecognised", reason: "no docs array in the search result" };
  const docs = data["docs"] as Record<string, unknown>[];
  // An empty docs array is the honest "that number is not in Parldok".
  if (docs.length === 0) return { kind: "absent" };
  const id = docs[0]?.["id"];
  const queryId = data["queryid"];
  if (typeof id !== "number" || typeof queryId !== "number") {
    return { kind: "unrecognised", reason: "a hit without a numeric id or queryid" };
  }
  return { kind: "found", value: { id, queryId } };
}

/**
 * The answer among a Vorgang's positions. Positions are labelled in prose — the
 * answer's reads "Antwort auf Kleine Anfrage <ministry>" — and carry the document's
 * own link, which is what gets fetched.
 */
export function answerPosition(body: string): ApiReading<{ url: string; reference?: string }> {
  const data = successPayload(body);
  if (data === undefined) return { kind: "unrecognised", reason: "not a Parldok success envelope" };
  const process = data["process"];
  if (typeof process !== "object" || process === null) return { kind: "unrecognised", reason: "no process object" };
  const positions = (process as Record<string, unknown>)["positions"];
  if (!Array.isArray(positions)) return { kind: "unrecognised", reason: "no positions array" };

  let unusable: string | undefined;
  for (const entry of positions as Record<string, unknown>[]) {
    const text = typeof entry["text"] === "string" ? entry["text"] : "";
    if (!/\bAntwort\b/i.test(text)) continue;
    const document = entry["doc"];
    // An Antwort we can see and cannot follow is not an unanswered Anfrage. Keep
    // looking — a Vorgang can list more than one — but remember that we saw it.
    if (typeof document !== "object" || document === null) {
      unusable ??= "an Antwort position with no document";
      continue;
    }
    const link = (document as Record<string, unknown>)["prelink"] ?? (document as Record<string, unknown>)["link"];
    if (typeof link !== "string" || link === "") {
      unusable ??= "an Antwort position whose document carries no link";
      continue;
    }
    const found: { url: string; reference?: string } = { url: `${PARLDOK_WEB}${link}` };
    // The slug carries the Drucksachennummer: `/dokument/103169/8_1715_personal…`.
    const match = /\/dokument\/\d+\/(\d{1,2})_0*(\d+)_/.exec(link);
    if (match !== null) found.reference = `${match[1]}/${match[2]}`;
    return { kind: "found", value: found };
  }
  if (unusable !== undefined) return { kind: "unrecognised", reason: unusable };
  // No Antwort position at all: an Anfrage nobody has answered yet looks like this.
  return { kind: "absent" };
}

export class ThueringenSource implements Source {
  readonly key = "thueringen";
  readonly parliament = "thueringen" as const;
  readonly tier = "structured" as const;
  readonly label = "Thüringer Landtag (Parldok)";
  readonly homepage = "https://parldok.thueringer-landtag.de/ParlDok/";
  readonly notes =
    "Discovery runs through the Parlamentsspiegel, which lists the answer as a follow-up document " +
    "linking Parldok's viewer. The answer is a Drucksache with no relation to the Kleine Anfrage's number (8/979 is " +
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
      // combined paper; the Kleine Anfrage itself stays as the question source. The
      // API's URL replaces the result row's link to the same paper — appending both
      // would fetch and extract it twice.
      const documents: DocRefDocument[] = [
        ...ref.documents.filter((document) => document.role === "question_pdf"),
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
      if (hit.kind === "unrecognised") {
        warnings.push(
          `${ref.reference}: Parldok's search answered in a form this adapter does not know ` +
            `(${hit.reason}) — treated as no answer, but the API may have changed`,
        );
        return undefined;
      }
      if (hit.kind === "absent") {
        warnings.push(`${ref.reference}: Parldok found no Kleine Anfrage with that number`);
        return undefined;
      }
      const process = await options.engine.post(`${PARLDOK_API}/Process/Document`, {
        body: `data=${encodeURIComponent(processBody(hit.value.id, hit.value.queryId))}`,
        headers: { accept: "application/json" },
      });
      const answer = answerPosition(process.body.toString("utf8"));
      if (answer.kind === "unrecognised") {
        warnings.push(
          `${ref.reference}: Parldok's Vorgang answered in a form this adapter does not know ` +
            `(${answer.reason}) — treated as no answer, but the API may have changed`,
        );
        return undefined;
      }
      // Not an error: an Anfrage that has not been answered yet looks exactly like
      // this, and so does one whose answer Parldok has not published.
      if (answer.kind === "absent") return undefined;
      return answer.value;
    } catch (err) {
      warnings.push(`${ref.reference}: could not reach Parldok (${(err as Error).message})`);
      return undefined;
    }
  }
}

/** How this connector announces itself to the registry and `ka sources list`. */
export const ENTRY: SourceEntry = {
  key: "thueringen",
  parliament: "thueringen",
  label: "Thüringer Landtag (Parldok)",
  status: "implemented",
  note: "aggregator discovery, with the answer Drucksache looked up through Parldok's own JSON API",
  factory: () => new ThueringenSource(),
};
