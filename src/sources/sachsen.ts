// Sachsen: the Sächsischer Landtag, whose documents sit behind EDAS, a frameset
// viewer.
//
// The Parlamentsspiegel links to `edas.landtag.sachsen.de/viewer.aspx?dok_art=Drs&
// dok_nr=3284&leg_per=8`, which returns a 1.7 kB frameset. The file itself lives on
// a different host under an opaque name:
//
//   https://ws.landtag.sachsen.de/images/8_Drs_3284_0_1_1_.pdf
//
// That name *looks* constructible — `<period>_<art>_<number>_0_1_1_.pdf` held for
// every document checked — but the trailing `_0_1_1_` is not documented anywhere and
// nothing says it is invariant. So this adapter reads the link out of the viewer's
// own navigation frame instead of assembling it. That costs one request per
// document and buys a URL the Landtag published rather than one we invented.
//
// The resolved link is a plain static file, which also settles a question the
// concept raised: Sachsen's *viewer* links are session-bound and short-lived, but
// the resolved document URL is not, so these records can carry `url_stable: true`.

import { OpenKaApiError } from "../core/errors.js";
import type { DiscoverOptions, DiscoverResult, DocRef, DocRefDocument, Source } from "./base.js";
import { ParlamentsspiegelSource } from "./parlamentsspiegel.js";

export const EDAS_HOST = "edas.landtag.sachsen.de";

/** The viewer's navigation frame, which names the real file. */
export function sachsenNavigationUrl(viewerUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(viewerUrl);
  } catch {
    return undefined;
  }
  if (!url.host.endsWith("landtag.sachsen.de") || !url.pathname.toLowerCase().endsWith("viewer.aspx")) {
    return undefined;
  }
  return `https://${EDAS_HOST}/viewer/viewer_navigation.aspx${url.search}`;
}

/**
 * The document positions a Vorgang holds, read from the navigation frame's buttons
 * (`anzeigeButton_3284_0_Drs_8_no`, `anzeigeButton_3284_1_Drs_8_no`). EDAS answers
 * an unrefined query with "Mehrere Dokumente gefunden, bitte verfeinern" and shows
 * only the first; these ids are how it enumerates the rest.
 */
export function sachsenPositions(html: string): number[] {
  const positions = new Set<number>();
  const pattern = /anzeigeButton_\d+_(\d+)_[A-Za-z]+_\d+_no/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) positions.add(Number(match[1]));
  return [...positions].sort((a, b) => a - b);
}

/**
 * Refine the navigation URL to one document position. The parameter names are the
 * ones EDAS's own `DokumentAnzeige.js` uses when it opens a document:
 * `viewer.aspx?dok_nr=…&dok_art=…&leg_per=…&pos_dok=<position>&dok_id=<id>`.
 */
export function sachsenPositionUrl(navigationUrl: string, position: number): string {
  const url = new URL(navigationUrl);
  url.searchParams.set("pos_dok", String(position));
  url.searchParams.set("dok_id", "0");
  return url.toString();
}

/** Pull the document link out of the navigation frame's markup. */
export function sachsenPdfUrlFrom(html: string): string | undefined {
  // The link is embedded inside a JavaScript call with HTML-escaped quotes.
  const unescaped = html.replace(/&#39;/g, "'").replace(/&quot;/g, '"');
  const match = /https:\/\/[^"'\s]*\.pdf/i.exec(unescaped);
  return match === null ? undefined : match[0];
}

export class SachsenSource implements Source {
  readonly key = "sachsen";
  readonly parliament = "sachsen" as const;
  readonly tier = "structured" as const;
  readonly label = "Sächsischer Landtag (EDAS)";
  readonly homepage = "https://edas.landtag.sachsen.de/";
  readonly notes =
    "Discovery runs through the Parlamentsspiegel, whose links point at the EDAS frameset viewer " +
    "rather than at a file. Each document is resolved by reading the viewer's own navigation " +
    "frame, which names the static PDF on ws.landtag.sachsen.de — one extra request per document, " +
    "and a URL the Landtag published rather than one assembled from a pattern.";

  private readonly aggregator = new ParlamentsspiegelSource("sachsen");

  async discover(options: DiscoverOptions): Promise<DiscoverResult> {
    const discovered = await this.aggregator.discover(options);
    const warnings = [...discovered.warnings];
    const refs: DocRef[] = [];
    const cache = new Map<string, string[]>();

    for (const ref of discovered.refs) {
      const viewer = ref.documents[0]?.url;
      if (viewer === undefined) {
        refs.push(ref);
        continue;
      }
      if (!cache.has(viewer)) cache.set(viewer, await this.resolveAll(viewer, options, warnings));
      const urls = cache.get(viewer) as string[];

      if (urls.length === 0) {
        refs.push(ref);
        continue;
      }
      // EDAS lists the Kleine Anfrage first and the reply after it.
      const documents: DocRefDocument[] = urls.map((url, index) => ({
        role: index === 0 ? ("question_pdf" as const) : ("answer_pdf" as const),
        url,
        urlStable: true,
      }));
      refs.push({ ...ref, documents: mergeDuplicates(documents) });
    }

    const result: DiscoverResult = { refs, warnings };
    if (discovered.state !== undefined) result.state = discovered.state;
    if (discovered.unchanged !== undefined) result.unchanged = discovered.unchanged;
    return result;
  }

  /**
   * Resolve one viewer link to every document behind it.
   *
   * The first position is the Kleine Anfrage and the later ones are the
   * government's reply, in the order EDAS lists them. Each position costs one
   * request, which is the price of reading the links the Landtag publishes instead
   * of assembling file names: the obvious guess — substituting the position into
   * `8_Drs_3284_0_1_1_.pdf` — happens to be right here, but nothing documents the
   * other two slots, and a wrong guess is a 404 that looks like a missing document.
   */
  private async resolveAll(
    viewerUrl: string,
    options: DiscoverOptions,
    warnings: string[],
  ): Promise<string[]> {
    const navigation = sachsenNavigationUrl(viewerUrl);
    if (navigation === undefined) return [];
    let first: string;
    let positions: number[];
    try {
      const response = await options.engine.get(navigation, { headers: { accept: "text/html" } });
      const html = response.body.toString("latin1");
      positions = sachsenPositions(html);
      const direct = sachsenPdfUrlFrom(html);
      if (direct === undefined) {
        warnings.push(`${viewerUrl}: the EDAS viewer page named no document; kept as discovered`);
        return [];
      }
      first = direct;
    } catch (err) {
      const reason = err instanceof OpenKaApiError ? `HTTP ${err.status}` : (err as Error).message;
      warnings.push(`${viewerUrl}: could not read the EDAS viewer page (${reason})`);
      return [];
    }

    const urls = [first];
    for (const position of positions.slice(1)) {
      if (urls.length >= MAX_POSITIONS) {
        warnings.push(`${viewerUrl}: stopped after ${MAX_POSITIONS} document positions`);
        break;
      }
      try {
        const response = await options.engine.get(sachsenPositionUrl(navigation, position), {
          headers: { accept: "text/html" },
        });
        const direct = sachsenPdfUrlFrom(response.body.toString("latin1"));
        if (direct !== undefined && !urls.includes(direct)) urls.push(direct);
      } catch {
        warnings.push(`${viewerUrl}: could not read document position ${position}`);
      }
    }
    return urls;
  }
}

/** A Vorgang with more positions than this is not a Kleine Anfrage with an answer. */
const MAX_POSITIONS = 6;

/**
 * Sachsen's Vorgang lists the question and the answer under one viewer link, so
 * both resolve to the same file. One document, holding both, is `combined_pdf` —
 * recording it twice under two roles would claim two sources where there is one.
 */
export function mergeDuplicates(documents: DocRefDocument[]): DocRefDocument[] {
  const byUrl = new Map<string, DocRefDocument[]>();
  for (const document of documents) {
    byUrl.set(document.url, [...(byUrl.get(document.url) ?? []), document]);
  }
  const out: DocRefDocument[] = [];
  for (const [url, group] of byUrl) {
    const first = group[0] as DocRefDocument;
    const roles = new Set(group.map((document) => document.role));
    const combined = roles.has("question_pdf") && roles.has("answer_pdf");
    out.push({ ...first, url, ...(combined ? { role: "combined_pdf" as const } : {}) });
  }
  return out;
}
