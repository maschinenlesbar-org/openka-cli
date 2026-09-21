// The source registry: every parliament OpenKA covers, and the honest state of its
// adapter.
//
// All 17 are listed, including the ones with no adapter yet. That is deliberate —
// `ka sources list` should show the whole map with the gaps visible, because a
// silent absence looks exactly like a source that found nothing, and the difference
// matters to anyone deciding whether the corpus can answer their question.

import { PARLIAMENTS, type ParliamentKey } from "../core/models/parliaments.js";
import type { Source } from "./base.js";
import { BerlinSource } from "./berlin.js";
import { BundDipSource } from "./bund.js";
import { NordrheinWestfalenSource } from "./nordrhein-westfalen.js";
import { SaarlandSource } from "./saarland.js";
import { SachsenSource } from "./sachsen.js";
import { NiedersachsenSource } from "./niedersachsen.js";
import { ThueringenSource } from "./thueringen.js";
import { ParlamentsspiegelSource } from "./parlamentsspiegel.js";

export type SourceStatus = "implemented" | "via_aggregator" | "planned";

export interface SourceEntry {
  key: string;
  parliament: ParliamentKey;
  label: string;
  status: SourceStatus;
  /** Why it is in this state, in one line. */
  note: string;
  /** Present only for `implemented` entries. */
  factory?: () => Source;
}

/**
 * Every Land that delivers to the Parlamentsspiegel can be synced through the
 * aggregator adapter today; a dedicated adapter is better where the Land publishes
 * its own feed, as Berlin does.
 */
function aggregatorEntry(parliament: ParliamentKey, label: string): SourceEntry {
  return {
    key: parliament,
    parliament,
    label,
    status: "via_aggregator",
    note: "no dedicated adapter yet — reachable through `--source parlamentsspiegel`, metadata plus PDF links only",
    factory: () => new ParlamentsspiegelSource(parliament),
  };
}

export const SOURCE_REGISTRY: readonly SourceEntry[] = [
  {
    key: "bund",
    parliament: "bund",
    label: "Deutscher Bundestag (DIP API)",
    status: "implemented",
    note: "structured JSON API; needs an API key (--api-key / DIP_API_KEY)",
    factory: () => new BundDipSource(),
  },
  {
    key: "berlin",
    parliament: "berlin",
    label: "Abgeordnetenhaus von Berlin (PARDOK open data)",
    status: "implemented",
    note: "daily XML export per Wahlperiode in the Parlamentsspiegel Export 1.0 format",
    factory: () => new BerlinSource(),
  },
  {
    key: "nordrhein-westfalen",
    parliament: "nordrhein-westfalen",
    label: "Landtag Nordrhein-Westfalen",
    status: "implemented",
    note: "discovery through the Parlamentsspiegel (the Landtag's own search is robots-disallowed), with document URLs built from the Drucksachennummer",
    factory: () => new NordrheinWestfalenSource(),
  },
  {
    key: "saarland",
    parliament: "saarland",
    label: "Landtag des Saarlandes",
    status: "implemented",
    note: "aggregator discovery, with document URLs unwrapped from the Landtag's iframe page",
    factory: () => new SaarlandSource(),
  },
  {
    key: "sachsen",
    parliament: "sachsen",
    label: "Sächsischer Landtag (EDAS)",
    status: "implemented",
    note: "aggregator discovery, with documents resolved through the EDAS viewer's navigation frame",
    factory: () => new SachsenSource(),
  },
  {
    key: "thueringen",
    parliament: "thueringen",
    label: "Thüringer Landtag (Parldok)",
    status: "implemented",
    note: "aggregator discovery, with the answer Drucksache looked up through Parldok's own JSON API",
    factory: () => new ThueringenSource(),
  },
  {
    key: "niedersachsen",
    parliament: "niedersachsen",
    label: "Niedersächsischer Landtag",
    status: "implemented",
    note: "aggregator discovery; answers come from a frozen map built by `ka-factory answers niedersachsen`",
    factory: () => new NiedersachsenSource(),
  },
  {
    key: "parlamentsspiegel",
    parliament: "nordrhein-westfalen",
    label: "Parlamentsspiegel (all 16 Länder)",
    status: "implemented",
    note: "HTML search of the Länder's shared portal; metadata and PDF links for every Land",
    factory: () => new ParlamentsspiegelSource(),
  },
  ...PARLIAMENTS.filter(
    (parliament) =>
      parliament.key !== "bund" &&
      parliament.key !== "berlin" &&
      parliament.key !== "nordrhein-westfalen" &&
      parliament.key !== "saarland" &&
      parliament.key !== "sachsen" &&
      parliament.key !== "thueringen" &&
      parliament.key !== "niedersachsen" &&
      parliament.herkunft !== undefined,
  ).map((parliament) => aggregatorEntry(parliament.key, parliament.label)),
];

const BY_KEY = new Map(SOURCE_REGISTRY.map((entry) => [entry.key, entry]));

export function sourceEntry(key: string): SourceEntry | undefined {
  return BY_KEY.get(key);
}

/** Every registered key, sorted — what `--source` accepts. */
export function sourceKeys(): string[] {
  return [...BY_KEY.keys()].sort();
}

/** Build a source, or throw with a message naming what is available. */
export function createSource(key: string): Source {
  const entry = BY_KEY.get(key);
  if (entry?.factory === undefined) {
    throw new Error(
      entry === undefined
        ? `Unknown source "${key}". Known sources: ${sourceKeys().join(", ")}.`
        : `Source "${key}" is registered but has no adapter yet (${entry.note}).`,
    );
  }
  return entry.factory();
}
