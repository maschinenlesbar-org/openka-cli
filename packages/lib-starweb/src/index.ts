// STARWEB — the parliamentary documentation system several Landtage run.
//
// Bremen (PARiS), Rheinland-Pfalz (OPAL) and Schleswig-Holstein (e-LISSH) all use
// it, and so does Sachsen-Anhalt (PADOKA), whose robots.txt disallows everything
// and which is therefore not reached from here at all.
//
// It is not an API. It is a **stateful HTML form**, and that shapes everything
// below:
//
//   1. GET the search page. It carries a `__websessionID` and a `__sessionNumber`
//      in hidden inputs, and a POST without them is answered with the search page
//      again rather than with results.
//   2. POST every hidden field back, plus the search fields, plus `__action` — the
//      number of the control being "pressed". The page declares it in the button's
//      own `caSubmit(this,self,'20',…)` call, so it is read from the page rather
//      than hard-coded, because it is a template detail and not a contract.
//   3. Parse the result page. Each hit is a `<tbody name="RecordRepeater">`.
//
// What belongs here is that handshake and the record-block extraction, which are
// the same everywhere. What a record's line *says* — where the Drucksachennummer
// sits, what the type is called, which Fraktion asked — differs per Land and stays
// in the connector.

import { decodeHtml } from "@maschinenlesbar.org/openka-lib-source";
import type { FetchEngine } from "@maschinenlesbar.org/openka-lib-http";

/** One installation's addresses. */
export interface StarwebEndpoint {
  /** The servlet every request goes to. */
  servlet: string;
  /** The `path` of the advanced search template, e.g. `paris/LISSH.web`. */
  searchPath: string;
}

/** The hidden state a STARWEB search needs carried from the form to the POST. */
export interface StarwebSession {
  fields: Record<string, string>;
  /** The `__action` the search button submits, read from the page. */
  searchAction: string;
}

/** Every hidden input on a page, in document order. */
export function hiddenFields(html: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const pattern = /<input\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    const tag = match[0];
    if (!/type="?hidden/i.test(tag)) continue;
    const name = /name="([^"]+)"/i.exec(tag)?.[1];
    if (name === undefined) continue;
    fields[name] = decodeHtml(/value="([^"]*)"/i.exec(tag)?.[1] ?? "");
  }
  return fields;
}

/**
 * The `__action` number a named control submits.
 *
 * The page writes it into the control's own `caSubmit(this,self,'20',…)`, and the
 * numbers are assigned per template — Bremen's search is 20, and nothing promises
 * another installation agrees. Reading it is one regex; guessing it returns the
 * search page again with no error, which is the worst way for this to fail.
 */
export function actionOf(html: string, control: string): string | undefined {
  const at = html.indexOf(`name="${control}"`);
  if (at < 0) return undefined;
  const before = html.slice(Math.max(0, at - 400), at);
  const calls = [...before.matchAll(/caSubmit\(this,\s*self,\s*'(\d+)'/g)];
  return calls[calls.length - 1]?.[1];
}

/** GET the search form and take the session state out of it. */
export async function openSearch(
  engine: FetchEngine,
  endpoint: StarwebEndpoint,
  options: { control?: string } = {},
): Promise<StarwebSession | undefined> {
  const response = await engine.get(endpoint.servlet, {
    params: { path: endpoint.searchPath },
    headers: { accept: "text/html" },
  });
  return sessionFrom(response.body.toString("utf8"), options.control);
}

/** The session state of an already-fetched search page. */
export function sessionFrom(html: string, control = "SearchAndDisplayAction"): StarwebSession | undefined {
  const fields = hiddenFields(html);
  const searchAction = actionOf(html, control);
  if (fields["__websessionID"] === undefined || searchAction === undefined) return undefined;
  return { fields, searchAction };
}

/** POST a search in an open session. */
export async function runSearch(
  engine: FetchEngine,
  endpoint: StarwebEndpoint,
  session: StarwebSession,
  search: Record<string, string>,
): Promise<string> {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...session.fields, ...search, __action: session.searchAction })) {
    form.set(key, value);
  }
  const response = await engine.post(endpoint.servlet, {
    body: form.toString(),
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
  });
  return response.body.toString("utf8");
}

/** One hit per `<tbody name="RecordRepeater">`. */
export function recordBlocks(html: string): string[] {
  return [...html.matchAll(/<tbody\b[^>]*name="RecordRepeater"[^>]*>([\s\S]*?)<\/tbody\s*>/gi)].map((m) => m[1] ?? "");
}

/** The visible text of a block, entities decoded and whitespace collapsed. */
export function blockText(block: string): string {
  return decodeHtml(block.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

/** The first absolute PDF link in a block — STARWEB links the file directly. */
export function pdfHref(block: string): string | undefined {
  return /href="(https?:\/\/[^"]+\.pdf)"/i.exec(block)?.[1];
}

/** The record's own id, e.g. `D-99112`, which the result page uses to open it. */
export function recordId(block: string): string | undefined {
  return /ID=([A-Za-z]-\d+)/.exec(block)?.[1];
}

/** "Anzeige: 1 - 25 von 42 Vorgängen" — how many the search actually matched. */
export function totalHits(html: string): number | undefined {
  const match = /von\s*(\d+)\s*(?:Vorg[äa]ngen|Dokumenten)/i.exec(blockText(html));
  return match === undefined || match === null ? undefined : Number(match[1]);
}

/** True when the result page says the search matched nothing. */
export function noHits(html: string): boolean {
  return /keine\s+Treffer/i.test(blockText(html));
}
