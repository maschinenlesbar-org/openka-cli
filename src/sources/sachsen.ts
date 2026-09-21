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

    for (const ref of discovered.refs) {
      const documents: DocRefDocument[] = [];
      const resolved = new Map<string, string | undefined>();

      for (const document of ref.documents) {
        if (!resolved.has(document.url)) {
          resolved.set(document.url, await this.resolve(document.url, options, warnings));
        }
        const direct = resolved.get(document.url);
        documents.push(
          direct === undefined ? document : { ...document, url: direct, urlStable: true },
        );
      }

      refs.push({ ...ref, documents: mergeDuplicates(documents) });
    }

    const result: DiscoverResult = { refs, warnings };
    if (discovered.state !== undefined) result.state = discovered.state;
    if (discovered.unchanged !== undefined) result.unchanged = discovered.unchanged;
    return result;
  }

  private async resolve(
    viewerUrl: string,
    options: DiscoverOptions,
    warnings: string[],
  ): Promise<string | undefined> {
    const navigation = sachsenNavigationUrl(viewerUrl);
    if (navigation === undefined) return undefined;
    try {
      const response = await options.engine.get(navigation, { headers: { accept: "text/html" } });
      const direct = sachsenPdfUrlFrom(response.body.toString("latin1"));
      if (direct === undefined) {
        warnings.push(`${viewerUrl}: the EDAS viewer page named no document; kept as discovered`);
      }
      return direct;
    } catch (err) {
      const reason = err instanceof OpenKaApiError ? `HTTP ${err.status}` : (err as Error).message;
      warnings.push(`${viewerUrl}: could not read the EDAS viewer page (${reason})`);
      return undefined;
    }
  }
}

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
