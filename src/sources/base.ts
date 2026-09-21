// The Source protocol — the "set of clients" layer.
//
// A source knows three things and nothing else: where its parliament publishes,
// how to page through that publication, and which URLs belong to one Anfrage. It
// does not extract: extraction is shared, deterministic and parameterised by the
// tier the source declares. Keeping adapters this thin is what stops a redesign at
// one Landtag from turning into a rewrite.

import type { ParliamentKey } from "../core/models/parliaments.js";
import type {
  AnsweredBy,
  Asker,
  Dates,
  DocumentType,
  SourceDocumentRole,
  Tier,
} from "../core/models/schema.js";
import type { FetchEngine } from "../core/http/engine.js";
import type { SourceState } from "../core/store/store.js";
import type { SegmentationRules } from "../core/extract/segment.js";

/** A document belonging to an Anfrage, as the source advertises it. */
export interface DocRefDocument {
  role: SourceDocumentRole;
  url: string;
  /**
   * False when the URL is known not to be durable — Sachsen's document links
   * expire after 15 minutes, so a record pointing at one is only retrievable
   * through the archived blob.
   */
  urlStable: boolean;
}

/** One Anfrage the source found, with everything it knows for certain about it. */
export interface DocRef {
  /** Stable within the source; used for de-duplication across runs. */
  key: string;
  /**
   * The parliament this Anfrage belongs to, when the source covers more than one.
   * The Parlamentsspiegel aggregates 16 Länder, so each result names its own;
   * a single-parliament source leaves this out and the source's key applies.
   */
  parliament?: ParliamentKey;
  reference: string;
  legislative_period: number;
  title: string;
  documentType: DocumentType;
  askers: Asker[];
  answered_by: AnsweredBy;
  dates: Dates;
  documents: DocRefDocument[];
}

export interface DiscoverOptions {
  engine: FetchEngine;
  /** Per-source state from the corpus: conditional-request validators and history. */
  state: SourceState;
  /** Only Anfragen dated on or after this ISO date. */
  since?: string;
  /** Only Anfragen dated on or before this ISO date. */
  until?: string;
  /** Restrict to one legislative period. */
  period?: number;
  /** Stop after this many refs. */
  limit?: number;
  /** Credential for sources that need one, already resolved from flag or env. */
  apiKey?: string;
  /**
   * Ignore cached validators and re-read the upstream feed. Without this a source
   * that answers 304 would report "nothing changed" even when the caller asked for
   * a full re-extraction, which makes `ka sync --force` silently do nothing.
   */
  force?: boolean;
}

export interface DiscoverResult {
  refs: DocRef[];
  /** Non-fatal problems: a page that would not parse, a field that was missing. */
  warnings: string[];
  /** Updated conditional-request state to persist. */
  state?: SourceState;
  /** True when the upstream reported nothing changed since the last run. */
  unchanged?: boolean;
}

export interface Source {
  readonly key: string;
  readonly parliament: ParliamentKey;
  /** The tier the pipeline runs for documents from this source. */
  readonly tier: Tier;
  readonly label: string;
  /** Where a human can see the same data. */
  readonly homepage: string;
  /** What is genuinely specific about this source — quirks worth knowing. */
  readonly notes: string;
  /** Environment variable holding this source's credential, when it needs one. */
  readonly apiKeyEnv?: string;
  /** Rule sets to use for segmentation; the shared default when omitted. */
  readonly ruleSets?: readonly SegmentationRules[];
  discover(options: DiscoverOptions): Promise<DiscoverResult>;
}

/** Keep only refs inside the requested date window and period, in a stable order. */
export function applyWindow(refs: DocRef[], options: DiscoverOptions): DocRef[] {
  const filtered = refs.filter((ref) => {
    const date = ref.dates.answered ?? ref.dates.submitted;
    if (options.since !== undefined && (date === undefined || date < options.since)) return false;
    if (options.until !== undefined && (date === undefined || date > options.until)) return false;
    if (options.period !== undefined && ref.legislative_period !== options.period) return false;
    return true;
  });
  filtered.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return options.limit === undefined ? filtered : filtered.slice(0, options.limit);
}
