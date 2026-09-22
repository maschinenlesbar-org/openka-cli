// Parldok — the parliamentary documentation system several Landtage run.
//
// Thüringen was the first Land here to use it and the client was written inside
// that connector. It is not Thüringen-specific: Mecklenburg-Vorpommern runs the
// same software, answering the same endpoints with the same JSON envelope, and
// only the hosts differ. So the client lives here and a connector supplies its
// Land's two addresses.
//
// The application is a single-page app whose search runs over a JSON API, and this
// speaks it the way the application does:
//
//   Fulltext/Search   find documents by kind, number and Wahlperiode
//   Process/Document  list a Vorgang's positions, one of which is the answer
//
// That API is **undocumented**. It is each site's own public endpoint serving
// public documents, and asking it for JSON is gentler than scraping the rendered
// page, but nothing promises it will keep its shape. Every response is therefore
// read into an `ApiReading`, so "there is nothing" and "I do not understand this"
// stay different facts — a distinction the callers need, because only the second
// is a reason to go looking somewhere else.

import type { FetchEngine } from "@maschinenlesbar.org/openka-lib-http";

/** The two addresses a Parldok installation has. */
export interface ParldokEndpoint {
  /** The API host the application posts to. */
  api: string;
  /** The public host documents are served from. */
  web: string;
}

/**
 * Facet ids, read from the application's own `pd.facet_*` constants. They are part
 * of the software, not of a Land's data: the Thüringen and Mecklenburg-Vorpommern
 * bundles declare byte-identical values.
 */
export const FACET_KIND = 7;
export const FACET_TYPE = 8;
export const FACET_TIME = 9;
export const FACET_LP = 10;
export const FACET_NUMBER = 14;

/**
 * Which facet holds "Kleine Anfrage" is **not** part of the software.
 *
 * Thüringen files it under `Dokumentart` (facet 7); Mecklenburg-Vorpommern's facet 7
 * is Drucksache/Protokoll/Amtliche Mitteilung and the question type lives under
 * `Dokumenttyp` (facet 8) instead. Each connector says which one its installation
 * uses, and the ids come from that installation's own facet listing.
 */
export const FACET_KIND_MV = FACET_TYPE;

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
/** How an installation says the answer has not been published yet. */
const PENDING_ANSWER = /(noch nicht vor|wird noch erfasst|liegt nicht vor)/i;

export function answerPosition(body: string, web: string): ApiReading<{ url: string; reference?: string }> {
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
    // A Vorgang nobody has answered yet still carries a position about the answer:
    // "Gedruckte Antwort liegt noch nicht vor/wird noch erfasst". It matches
    // "Antwort" and has no document, and reading that as an answer we failed to
    // follow reported every open Anfrage as an API we no longer understand.
    if (PENDING_ANSWER.test(text)) continue;
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
    const found: { url: string; reference?: string } = { url: `${web}${link}` };
    // The slug carries the Drucksachennummer: `/dokument/103169/8_1715_personal…`.
    const match = /\/dokument\/\d+\/(\d{1,2})_0*(\d+)_/.exec(link);
    if (match !== null) found.reference = `${match[1]}/${match[2]}`;
    return { kind: "found", value: found };
  }
  if (unusable !== undefined) return { kind: "unrecognised", reason: unusable };
  // No Antwort position at all: an Anfrage nobody has answered yet looks like this.
  return { kind: "absent" };
}


/** A search tag, as the application's own search page builds them. */
export interface SearchTag {
  type: number;
  id: string | number;
  label: string;
  /** `datefrom` / `dateto` on a time facet; absent on the others. */
  field?: string;
}

/** The body of a search for a list of documents, rather than for one by number. */
export function searchDocumentsBody(options: { tags: SearchTag[]; length?: number; start?: number }): string {
  return JSON.stringify({
    devicekey: "",
    ...SEARCH_DEFAULTS,
    limit: { Start: options.start ?? 0, Length: options.length ?? 200 },
    tags: options.tags.map((tag) => ({ ...tag, ored: true })),
  });
}

/** A page of search hits, with the query id a Vorgang lookup needs. */
export interface SearchHits {
  docs: Record<string, unknown>[];
  /**
   * `Process/Document` needs the id of the query the hit came from, so a listing
   * search already carries everything an answer lookup needs — no second search
   * per ref.
   */
  queryId: number;
  /** How many documents the search matched in all, when the page says. */
  total?: number;
}

/**
 * The hits of a listing search.
 *
 * `absent` is an empty result — a window in which the Land published nothing, which
 * is an answer. `unrecognised` is a response whose shape this client does not know,
 * which is not.
 */
export function searchResults(body: string): ApiReading<SearchHits> {
  const data = successPayload(body);
  if (data === undefined) return { kind: "unrecognised", reason: "not a Parldok success envelope" };
  if (!Array.isArray(data["docs"])) return { kind: "unrecognised", reason: "no docs array in the search result" };
  const docs = data["docs"] as Record<string, unknown>[];
  if (docs.length === 0) return { kind: "absent" };
  const queryId = data["queryid"];
  if (typeof queryId !== "number") return { kind: "unrecognised", reason: "a result with no queryid" };
  const hits: SearchHits = { docs, queryId };
  if (typeof data["count"] === "number") hits.total = data["count"];
  return { kind: "found", value: hits };
}

/** One hit of a listing, with the query id of the page it came from. */
export interface SearchHit {
  doc: Record<string, unknown>;
  queryId: number;
}

/** The most hits one page may carry; the application's own listing size. */
export const PAGE_LENGTH = 200;

/** Pages a listing may run to before this client stops asking. */
export const MAX_SEARCH_PAGES = 500;

/**
 * Every hit of a listing search, page by page.
 *
 * A page carries at most `PAGE_LENGTH` hits and says how many the search matched
 * in all (`count`). Both connectors used to ask for one page and stop, so a
 * Wahlperiode with more than 200 Kleine Anfragen came back as exactly 200 with no
 * sign that any were missing. This asks again with `Start` moved until the count is
 * reached, the page comes back short, or `limit` is met.
 *
 * Each hit keeps the query id of *its* page: `Process/Document` wants the id of the
 * query the document was found by, and a later page is a later query.
 */
export async function searchDocuments(
  engine: FetchEngine,
  api: string,
  options: { tags: SearchTag[]; limit?: number },
): Promise<ApiReading<SearchHit[]>> {
  const hits: SearchHit[] = [];
  const wanted = options.limit ?? Number.POSITIVE_INFINITY;
  for (let page = 0; page < MAX_SEARCH_PAGES && hits.length < wanted; page++) {
    const length = Math.min(PAGE_LENGTH, wanted - hits.length);
    const body = searchDocumentsBody({ tags: options.tags, length, start: hits.length });
    const response = await engine.post(`${api}/Fulltext/Search`, {
      body: `data=${encodeURIComponent(body)}`,
      headers: { accept: "application/json" },
    });
    const reading = searchResults(response.body.toString("utf8"));
    if (reading.kind === "unrecognised") return reading;
    if (reading.kind === "absent") break;
    for (const doc of reading.value.docs) hits.push({ doc, queryId: reading.value.queryId });
    const total = reading.value.total;
    if (total !== undefined && hits.length >= total) break;
    if (total === undefined && reading.value.docs.length < length) break;
  }
  if (hits.length === 0) return { kind: "absent" };
  return { kind: "found", value: hits.slice(0, options.limit) };
}
