// Berlin: the Abgeordnetenhaus publishes the metadata of its parliamentary
// documentation (PARDOK) as open data — one XML file per Wahlperiode, rebuilt
// daily, in the `Parlamentsspiegel Export 1.0` format:
//
//   https://www.parlament-berlin.de/opendata/pardok-wp19.xml
//
// That makes Berlin a `structured` source: every field of a record except the
// question and answer texts comes straight out of the export, and the texts come
// from the one PDF that Berlin publishes per Anfrage (question and answer in the
// same document, so the source document's role is `combined_pdf`).
//
// Berlin's instrument is the *Schriftliche Anfrage*, not the *Kleine Anfrage* —
// the same thing under the Land's own name, which is why `document_type` is part
// of the schema instead of being assumed.

import { OpenKaError, UsageError } from "@maschinenlesbar.org/openka-lib-errors";
import type { SourceState } from "@maschinenlesbar.org/openka-lib-store";
import { parsePardokExport } from "@maschinenlesbar.org/openka-lib-pardok";
import { applyWindow, type CountOptions, type DiscoverOptions, type DiscoverResult, type DocRef, type Source, type UpstreamCount } from "@maschinenlesbar.org/openka-lib-source";
import { ParlamentsspiegelSource } from "@maschinenlesbar.org/openka-lib-parlamentsspiegel";
import type { SourceEntry } from "@maschinenlesbar.org/openka-lib-source";

export const BERLIN_OPENDATA_BASE = "https://www.parlament-berlin.de/opendata";

/** Wahlperioden the open-data feed covers. 19 is current as of 2026-09. */
export const BERLIN_PERIODS = [11, 12, 13, 14, 15, 16, 17, 18, 19] as const;

export const BERLIN_LATEST_PERIOD = 19;

export function berlinFeedUrl(period: number): string {
  return `${BERLIN_OPENDATA_BASE}/pardok-wp${period}.xml`;
}

/**
 * Where the feed's validators are kept for one window: the feed URL with the window
 * (`since`, `until`, `limit`) as its fragment. A 304 says the feed did not change, not
 * that the window asked for now was handled: keyed by the URL alone, a sync of 2025
 * after one of 2026 got a 304 from the same Wahlperiode feed and discovered nothing
 * (issue #11). Kept per window, a 304 skips only a window that was synced before.
 */
export function berlinFeedKey(period: number, window: { since?: string; until?: string; limit?: number }): string {
  const parts = [`since=${window.since ?? ""}`, `until=${window.until ?? ""}`, `limit=${window.limit ?? ""}`];
  return `${berlinFeedUrl(period)}#${parts.join("&")}`;
}

export class BerlinSource implements Source {
  readonly key = "berlin";
  readonly parliament = "berlin" as const;
  readonly tier = "structured" as const;
  readonly label = "Abgeordnetenhaus von Berlin (PARDOK open data)";
  readonly homepage = "https://www.parlament-berlin.de/dokumente/open-data";
  readonly notes =
    "One XML file per Wahlperiode, rebuilt daily, in the Parlamentsspiegel Export 1.0 format; " +
    "the whole period is one 50+ MB download, so ETag/If-Modified-Since is what keeps a daily " +
    "sync cheap. Question and answer share one PDF. Berlin calls the instrument a Schriftliche Anfrage.";

  /**
   * Counted through the Parlamentsspiegel, which Berlin delivers to: one request,
   * where counting from the feed would mean its 50+ MB download per Wahlperiode.
   * The portal counts every period at once and cannot narrow to one.
   */
  async count(options: CountOptions): Promise<UpstreamCount> {
    return new ParlamentsspiegelSource(this.parliament).count(options);
  }

  async discover(options: DiscoverOptions): Promise<DiscoverResult> {
    const period = options.period ?? BERLIN_LATEST_PERIOD;
    if (!BERLIN_PERIODS.includes(period as (typeof BERLIN_PERIODS)[number])) {
      // The request, not the source: a usage error, so no "last error" is filed
      // against a Berlin that is working fine.
      throw new UsageError(
        `Berlin's open-data feed covers Wahlperioden ${BERLIN_PERIODS[0]}–${BERLIN_LATEST_PERIOD}; ` +
          `${period} was requested. If a new Wahlperiode has begun, the feed list in this adapter needs a bump.`,
      );
    }
    const url = berlinFeedUrl(period);
    const key = berlinFeedKey(period, options);
    const state: SourceState = { ...options.state, http_cache: { ...options.state.http_cache } };
    // Validators kept under the bare URL (before 2026-10-08) belong to an unknown
    // window, so they are not used, and are replaced below.
    delete state.http_cache[url];
    const cached = options.force === true ? undefined : state.http_cache[key];

    const response = await options.engine.get(url, {
      headers: { accept: "application/xml, text/xml" },
      ...(cached === undefined ? {} : { validators: { ...(cached.etag !== undefined ? { etag: cached.etag } : {}), ...(cached.last_modified !== undefined ? { last_modified: cached.last_modified } : {}) } }),
    });

    if (response.notModified) {
      return { refs: [], warnings: [], state, unchanged: true };
    }

    const entry: { etag?: string; last_modified?: string } = {};
    if (response.etag !== undefined) entry.etag = response.etag;
    if (response.lastModified !== undefined) entry.last_modified = response.lastModified;
    state.http_cache[key] = entry;

    const xml = response.body.toString("utf8");
    if (!xml.includes("<Export")) {
      throw new OpenKaError(
        `${url} did not return a Parlamentsspiegel export (no <Export> element). ` +
          "The feed layout may have changed — that is a factory job, not something to work around here.",
      );
    }

    const refs: DocRef[] = [];
    for (const ref of parsePardokExport(xml, { herkunft: "BLN" })) refs.push(ref);
    const warnings: string[] = [];
    const withoutDocuments = refs.filter((ref) => ref.documents.length === 0).length;
    if (withoutDocuments > 0) {
      warnings.push(`${withoutDocuments} Anfragen in the export carry no document URL; their qa stays abstained`);
    }
    state.documents_seen = refs.length;
    return { refs: applyWindow(refs, options), warnings, state };
  }
}

/** How this connector announces itself to the registry and `ka sources list`. */
export const ENTRY: SourceEntry = {
  key: "berlin",
  parliament: "berlin",
  label: "Abgeordnetenhaus von Berlin (PARDOK open data)",
  status: "implemented",
  note: "daily XML export per Wahlperiode in the Parlamentsspiegel Export 1.0 format",
  factory: () => new BerlinSource(),
};
