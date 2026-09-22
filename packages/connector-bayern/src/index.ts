// Bayern: the Landtag's own RSS feed of Anfragen, plus the static Drucksachen it
// files them under.
//
// The Bayerische Landtag publishes feeds at `/parlament/dokumente/rss-feeds/`. The
// one that matters here is `art=ANFRAGE`, "Drucksachen von Anfragen". robots.txt
// disallows `/service/suche` (the site search) and `/webangebot2/Vorgangsmappe`
// (the *old* Vorgangsmappe); the feed and the documents below are on neither path.
//
// Three things about this source had to be measured, and each one changes the
// design:
//
// **The feed mixes two instruments.** `art=ANFRAGE` carries both Schriftliche
// Anfragen — Bayern's instrument for this corpus — and Anfragen zum Plenum, the
// oral questions for a plenary sitting. Nothing in a feed item says which it is:
// every title reads "Initiativdrucksache 19/13327".
//
// **Anfragen zum Plenum are Sammeldrucksachen.** One Drucksache collects ~50
// separate questions, each a feed item with its own `gegenstandid` and subject but
// the *same* Drucksachennummer. Since a record's id derives from its reference,
// fifty of those would collide into one record.
//
// **The feed's link is not the document.** `vorgangsmappe.xhtml?gegenstandid=…`
// returns a Vorgangsmappe — a dossier generated on demand, carrying a `Stand:`
// timestamp, so two fetches of the same Anfrage differ in their bytes. A corpus
// built on byte-exact reproducibility should not archive that.
//
// All three are solved by the same observation: **Bayern files its Drucksachen at a
// static path that names the instrument.**
//
//   …/ElanTextAblage_WP19/Drucksachen/Schriftliche Anfragen/19_0013327.pdf
//
// A 200 there is proof the paper is a Schriftliche Anfrage; a 404 is proof it is
// not. So the type test is a HEAD against a constructed URL rather than a guess
// about the feed, and what gets archived is the Landtag's own stable file. That
// file is a combined paper: question and "Antwort des Staatsministeriums …" in one
// document.

import {
  FallbackSource,
  type DiscoverOptions,
  type DiscoverResult,
  type DocRef,
  type Source,
  type SourceEntry,
} from "@maschinenlesbar.org/openka-lib-source";
import { ParlamentsspiegelSource } from "@maschinenlesbar.org/openka-lib-parlamentsspiegel";
import { decodeEntities } from "@maschinenlesbar.org/openka-lib-source";
import { UsageError } from "@maschinenlesbar.org/openka-lib-errors";

export const PARLIAMENT = "bayern" as const;
export const LABEL = "Bayerischer Landtag";

export const LANDTAG_BAYERN = "https://www.bayern.landtag.de";

/** "Drucksachen von Anfragen" — the feed this adapter discovers from. */
export const ANFRAGEN_FEED = `${LANDTAG_BAYERN}/webangebot3/views/rssfeed/rssfeed.xhtml`;

/** The Wahlperiode currently sitting; the default when none is given. */
export const BAYERN_LATEST_PERIOD = 19;

/**
 * Where a Drucksache is filed. The folder names the instrument, which is what makes
 * it a test rather than a guess.
 */
export function drucksacheUrl(period: number, number: string): string {
  const padded = String(Number(number)).padStart(7, "0");
  return `${LANDTAG_BAYERN}/www/ElanTextAblage_WP${period}/Drucksachen/Schriftliche%20Anfragen/${period}_${padded}.pdf`;
}

export interface FeedItem {
  /** The Drucksachennummer, e.g. `19/13327`. */
  reference: string;
  period: number;
  number: string;
  /** The Anfrage's subject, which the feed carries as the item description. */
  subject: string;
  /** RFC 822 date the feed entry carries. */
  published?: string;
}

const ITEM = /<item>([\s\S]*?)<\/item>/g;
const FIELD = (block: string, tag: string): string | undefined => {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(block);
  return match === null ? undefined : decodeEntities((match[1] ?? "").trim());
};

/**
 * The feed's items.
 *
 * A title reads "Initiativdrucksache 19/13327" and is the only place the
 * Drucksachennummer appears; an item without one has no identity and is dropped.
 */
export function parseFeed(xml: string): FeedItem[] {
  const items: FeedItem[] = [];
  ITEM.lastIndex = 0;
  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = match[1] ?? "";
    const title = FIELD(block, "title") ?? "";
    const reference = /(\d+)\s*\/\s*(\d+)/.exec(title);
    if (reference === null) continue;
    const period = Number(reference[1]);
    if (!Number.isInteger(period) || period < 1) continue;
    const item: FeedItem = {
      reference: `${reference[1]}/${reference[2]}`,
      period,
      number: reference[2] as string,
      subject: FIELD(block, "description") ?? "",
    };
    const published = FIELD(block, "pubDate");
    if (published !== undefined) item.published = published;
    items.push(item);
  }
  return items;
}

/**
 * One entry per Drucksachennummer, keeping the first.
 *
 * An Anfrage zum Plenum contributes one feed item per question, all under the same
 * Drucksachennummer, so this collapses a Sammeldrucksache to a single candidate —
 * which the type test then rejects.
 */
export function byReference(items: FeedItem[]): FeedItem[] {
  const seen = new Set<string>();
  return items.filter((item) => (seen.has(item.reference) ? false : (seen.add(item.reference), true)));
}

export class BayernFeedSource implements Source {
  readonly key = PARLIAMENT;
  readonly parliament = PARLIAMENT;
  readonly tier = "text_layer" as const;
  readonly label = `${LABEL} (RSS)`;
  readonly homepage = "https://www.bayern.landtag.de/parlament/dokumente/rss-feeds/";
  readonly notes =
    "Discovery from the Landtag's own 'Drucksachen von Anfragen' RSS feed. The feed mixes " +
    "Schriftliche Anfragen with Anfragen zum Plenum and says which is which nowhere, so each " +
    "candidate is tested by asking whether the Landtag files it under 'Schriftliche Anfragen' — a " +
    "HEAD against a static path, where a 404 is the answer. What is archived is that static file, " +
    "a combined paper, rather than the Vorgangsmappe the feed links, which is generated per " +
    "request and differs in its bytes every time.";

  async discover(options: DiscoverOptions): Promise<DiscoverResult> {
    // The feed says when an entry appeared, not when the Anfrage was asked, and
    // this adapter claims no dates for that reason. So a date window cannot be
    // applied here — and silently returning everything the feed holds is the
    // dropped constraint this CLI refuses to produce. The dates the paper states
    // are extracted from it, so the window is answered by the corpus instead.
    if (options.since !== undefined || options.until !== undefined) {
      throw new UsageError(
        "Bayern's Anfragen feed carries no submission dates, so --since/--until cannot be applied to it. " +
          "Sync without a window (the feed holds only the newest Drucksachen) and filter the corpus " +
          "afterwards with --from/--to; the extractor reads the dates from each paper.",
      );
    }
    const warnings: string[] = [];
    const period = options.period ?? BAYERN_LATEST_PERIOD;

    const response = await options.engine.get(ANFRAGEN_FEED, {
      params: { art: "ANFRAGE", titel: "Drucksachen von Anfragen" },
      headers: { accept: "application/rss+xml" },
    });
    const xml = response.body.toString("utf8");
    if (!/<rss\b/i.test(xml)) {
      return { refs: [], warnings, unreadable: "the Anfragen feed did not answer with RSS" };
    }

    const candidates = byReference(parseFeed(xml)).filter((item) => item.period === period);
    const refs: DocRef[] = [];
    for (const item of candidates) {
      const url = drucksacheUrl(item.period, item.number);
      const probe = await options.engine.head(url);
      if (probe.status === 404) continue; // an Anfrage zum Plenum, not this instrument
      if (probe.status >= 400) {
        warnings.push(`Drucksache ${item.reference}: the Landtag answered ${probe.status} for its file; skipped`);
        continue;
      }
      refs.push(toRef(item, url));
      if (options.limit !== undefined && refs.length >= options.limit) break;
    }
    return { refs, warnings };
  }
}

/**
 * A candidate as a DocRef.
 *
 * No dates are claimed. The feed's `pubDate` is when the entry appeared, not when
 * the Anfrage was submitted or answered — the document carries both, in its own
 * header, and the extractor reads them there.
 */
export function toRef(item: FeedItem, url: string): DocRef {
  return {
    key: `drs:${item.reference}`,
    reference: item.reference,
    legislative_period: item.period,
    title: item.subject,
    documentType: "schriftliche_anfrage",
    askers: [],
    answered_by: {},
    dates: {},
    documents: [{ role: "combined_pdf", url, urlStable: true }],
  };
}

/** The Landtag's own feed, with the Parlamentsspiegel behind it. */
export function createSource(): Source {
  return new FallbackSource(new BayernFeedSource(), new ParlamentsspiegelSource(PARLIAMENT));
}

/** How this connector announces itself to the registry and `ka sources list`. */
export const ENTRY: SourceEntry = {
  key: PARLIAMENT,
  parliament: PARLIAMENT,
  label: LABEL,
  status: "implemented",
  note: "the Landtag's own Anfragen RSS feed plus its static Drucksachen, with the Parlamentsspiegel as a fallback",
  factory: createSource,
};
