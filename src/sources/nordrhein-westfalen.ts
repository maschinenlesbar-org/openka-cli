// Nordrhein-Westfalen: the Landtag NRW, the largest of the sixteen and the one that
// operates the Parlamentsspiegel for all of them.
//
// **Why this adapter does not talk to the Landtag's own search.** `landtag.nrw.de`
// publishes a document search at `/home/dokumente/dokumentensuche/`, and its
// robots.txt disallows it. Being a good citizen is a design principle here
// (CONCEPT.md §7), not a preference, so discovery goes through the Parlamentsspiegel
// — which is allowed, and which the Landtag NRW runs itself. The Landtag publishes
// no open-data feed and no API; the export DTD its own aggregator format references
// is behind authentication. That is worth stating plainly rather than leaving the
// next reader to rediscover it.
//
// **What this adapter adds** over syncing NRW through the generic aggregator:
//
//   * **Canonical document URLs.** The Drucksachennummer determines the file name —
//     `18/14035` is `…/dokumentenarchiv/Dokument/MMD18-14035.pdf` — so the URLs are
//     constructed rather than scraped. A record then stops depending on the
//     aggregator's link markup, and a change to that markup shows up as a warning
//     instead of as a broken record.
//   * **A robots.txt boundary that is enforced in code.** The Landtag disallows its
//     archive for the 11th–15th Wahlperiode; asking for one of those is an error
//     here, not a request we send anyway.
//   * Its own health row and `ka sources show` entry, so NRW's coverage can be
//     tracked separately from the aggregator's.
//
// Extraction needs nothing NRW-specific: its answer Drucksachen number the questions
// and let the answer follow directly, which the shared `antwort_folgt` rules read.

import { OpenKaError } from "../core/errors.js";
import { withDiscoveryState, type DiscoverOptions, type DiscoverResult, type DocRef, type DocRefDocument, type Source } from "./base.js";
import { ParlamentsspiegelSource } from "./parlamentsspiegel.js";

export const LANDTAG_NRW_HOST = "www.landtag.nrw.de";

/** The document archive, which robots.txt allows for the 16th Wahlperiode onwards. */
export const NRW_ARCHIVE = `https://${LANDTAG_NRW_HOST}/portal/WWW/dokumentenarchiv/Dokument`;

/**
 * Wahlperioden the Landtag's robots.txt disallows in the document archive
 * (`Disallow: /portal/WWW/dokumentenarchiv/Dokument/MM*11-` … `MM*15-`).
 */
export const ROBOTS_DISALLOWED_PERIODS = [11, 12, 13, 14, 15] as const;

/**
 * The canonical URL of a Drucksache, from its printed number.
 * `18/14035` -> `https://www.landtag.nrw.de/portal/WWW/dokumentenarchiv/Dokument/MMD18-14035.pdf`
 *
 * Returns `undefined` for anything that is not a plain `<period>/<number>` — the
 * caller then keeps whatever URL discovery supplied rather than inventing one.
 */
export function nrwDocumentUrl(reference: string): string | undefined {
  const match = /^(\d{1,2})\s*\/\s*(\d{1,6})$/.exec(reference.trim());
  if (match === null) return undefined;
  return `${NRW_ARCHIVE}/MMD${match[1]}-${match[2]}.pdf`;
}

/** The Drucksachennummer an archive URL refers to, or `undefined` if it is not one. */
export function referenceFromNrwUrl(url: string): string | undefined {
  const match = /\/MMD(\d{1,2})-(\d{1,6})\.pdf(?:$|[?#])/i.exec(url);
  return match === null ? undefined : `${match[1]}/${match[2]}`;
}

export class NordrheinWestfalenSource implements Source {
  readonly key = "nordrhein-westfalen";
  readonly parliament = "nordrhein-westfalen" as const;
  readonly tier = "structured" as const;
  readonly label = "Landtag Nordrhein-Westfalen";
  readonly homepage = "https://www.landtag.nrw.de/home/dokumente.html";
  readonly notes =
    "The Landtag publishes no API and no open-data feed, and its own document search is " +
    "disallowed by robots.txt — so discovery runs through the Parlamentsspiegel, which the " +
    "Landtag NRW itself operates. Document URLs are constructed from the Drucksachennummer " +
    "(MMD<wp>-<nr>.pdf) rather than scraped, so a record does not depend on the aggregator's " +
    "link markup. The archive is robots-disallowed for the 11th–15th Wahlperiode.";

  private readonly aggregator = new ParlamentsspiegelSource("nordrhein-westfalen");

  async discover(options: DiscoverOptions): Promise<DiscoverResult> {
    if (options.period !== undefined && (ROBOTS_DISALLOWED_PERIODS as readonly number[]).includes(options.period)) {
      throw new OpenKaError(
        `The Landtag NRW's robots.txt disallows its document archive for Wahlperiode ${options.period} ` +
          `(11–15). This client will not fetch it.`,
      );
    }

    const discovered = await this.aggregator.discover(options);
    const warnings = [...discovered.warnings];
    const refs = discovered.refs.map((ref) => this.canonicalise(ref, warnings));

    return withDiscoveryState(discovered, refs, warnings);
  }

  /**
   * Replace scraped document URLs with constructed ones, and say so when the two
   * disagree. A mismatch is not fatal — the aggregator may simply have linked a
   * different edition — but it is exactly the kind of quiet divergence that should
   * reach a human rather than being smoothed over.
   */
  private canonicalise(ref: DocRef, warnings: string[]): DocRef {
    const documents: DocRefDocument[] = ref.documents.map((document) => {
      // The question's number is the record's own reference; an answer carries its
      // own Drucksachennummer, which is only recoverable from the link.
      const reference =
        document.role === "question_pdf" ? ref.reference : referenceFromNrwUrl(document.url);
      const canonical = reference === undefined ? undefined : nrwDocumentUrl(reference);

      if (canonical === undefined) {
        if (!document.url.includes(LANDTAG_NRW_HOST)) {
          warnings.push(
            `${ref.reference}: the ${document.role} link points at ${hostOf(document.url)}, ` +
              "not the Landtag NRW archive; kept as discovered",
          );
        }
        return document;
      }
      if (canonical !== document.url && document.url !== "") {
        const discoveredReference = referenceFromNrwUrl(document.url);
        if (discoveredReference !== reference) {
          warnings.push(
            `${ref.reference}: discovery linked ${document.url} for the ${document.role}, ` +
              `but the Drucksachennummer says ${canonical}`,
          );
        }
      }
      return { ...document, url: canonical, urlStable: true };
    });

    // A Drucksache always has a question document, even when the aggregator's row
    // did not link one; the number is enough to address it.
    if (!documents.some((document) => document.role === "question_pdf")) {
      const canonical = nrwDocumentUrl(ref.reference);
      if (canonical !== undefined) documents.unshift({ role: "question_pdf", url: canonical, urlStable: true });
    }

    return { ...ref, documents };
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "an unparseable URL";
  }
}
