// Saarland: the Landtag des Saarlandes.
//
// The only thing specific about this source is where its documents actually live.
// The Parlamentsspiegel links to `landtag-saar.de/Drucksache/Af17_1326.pdf`, which
// is not the PDF — it is an HTML page whose whole body is an iframe:
//
//   <iframe src='/Downloadfile.ashx?FileId=-1&FileName=Af17_1326.pdf'></iframe>
//
// Fetching the link therefore stores 452 bytes of HTML as the "document", and the
// extractor then reports, correctly, that it found no text. That is how this Land
// spent a whole classification pass looking like a source of scanned PDFs when its
// documents in fact have a clean text layer.
//
// The rewrite below is the template from the wrapper's own markup, so it is the
// Landtag's statement of where the file is, not a guess.

import type { DiscoverOptions, DiscoverResult, DocRef, Source } from "./base.js";
import { ParlamentsspiegelSource } from "./parlamentsspiegel.js";

export const LANDTAG_SAAR_HOST = "www.landtag-saar.de";

/**
 * The direct URL of a Saarland document, from the wrapper URL the aggregator links.
 * Returns `undefined` for anything that is not a wrapper, so a link that is already
 * direct is left exactly as it is.
 */
export function saarlandDocumentUrl(url: string): string | undefined {
  const match = /^https?:\/\/(?:www\.)?landtag-saar\.de\/Drucksache\/([A-Za-z0-9_.-]+\.pdf)$/i.exec(url.trim());
  if (match === null) return undefined;
  return `https://${LANDTAG_SAAR_HOST}/Downloadfile.ashx?FileId=-1&FileName=${match[1]}`;
}

export class SaarlandSource implements Source {
  readonly key = "saarland";
  readonly parliament = "saarland" as const;
  readonly tier = "structured" as const;
  readonly label = "Landtag des Saarlandes";
  readonly homepage = "https://www.landtag-saar.de/";
  readonly notes =
    "Discovery runs through the Parlamentsspiegel. The links it carries point at an HTML wrapper " +
    "whose iframe holds the real file, so each document URL is rewritten to the Downloadfile.ashx " +
    "endpoint the wrapper itself names. Saarland's documents have a text layer; the wrapper was " +
    "the reason they looked like scans.";

  private readonly aggregator = new ParlamentsspiegelSource("saarland");

  async discover(options: DiscoverOptions): Promise<DiscoverResult> {
    const discovered = await this.aggregator.discover(options);
    const refs: DocRef[] = discovered.refs.map((ref) => ({
      ...ref,
      documents: ref.documents.map((document) => {
        const direct = saarlandDocumentUrl(document.url);
        return direct === undefined ? document : { ...document, url: direct, urlStable: true };
      }),
    }));
    const result: DiscoverResult = { refs, warnings: discovered.warnings };
    if (discovered.state !== undefined) result.state = discovered.state;
    if (discovered.unchanged !== undefined) result.unchanged = discovered.unchanged;
    return result;
  }
}
