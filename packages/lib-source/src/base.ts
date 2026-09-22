// The Source protocol — the "set of clients" layer.
//
// A source knows three things and nothing else: where its parliament publishes,
// how to page through that publication, and which URLs belong to one Anfrage. It
// does not extract: extraction is shared, deterministic and parameterised by the
// tier the source declares. Keeping adapters this thin is what stops a redesign at
// one Landtag from turning into a rewrite.

import type { ParliamentKey } from "@maschinenlesbar.org/openka-lib-models";
import { UsageError } from "@maschinenlesbar.org/openka-lib-errors";
import { DEFAULT_USER_AGENT } from "@maschinenlesbar.org/openka-lib-http";
import { NO_RULES, isAllowed, parseRobots } from "@maschinenlesbar.org/openka-lib-robots";
import type {
  AnsweredBy,
  Asker,
  Dates,
  DocumentType,
  SourceDocumentRole,
  Tier,
} from "@maschinenlesbar.org/openka-lib-models";
import type { FetchEngine } from "@maschinenlesbar.org/openka-lib-http";
import type { SourceState, Store } from "@maschinenlesbar.org/openka-lib-store";
import type { SegmentationRules } from "@maschinenlesbar.org/openka-lib-extract";

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
  /**
   * The corpus, for a source that consumes a frozen artifact the factory built.
   * Only Niedersachsen needs it, to read the question→answer map its sweep
   * produces; discovery still never *writes* to the store.
   */
  store?: Pick<Store, "loadArtifact">;
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
   * Fetch from a server whose robots.txt disallows it.
   *
   * Off by default, and never inferred: it is a flag the operator typed. Two Länder
   * publish their Drucksachen openly and disallow every client in robots.txt, so
   * this is the switch that decides whether their documents can be read at all. It
   * is not silent — every ref it produces carries a warning saying it was used.
   */
  ignoreRobots?: boolean;
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
  /**
   * Set when the source was reached but could not be read — a search page whose
   * markup contract broke, an API that answered in an unfamiliar shape.
   *
   * It is deliberately not the same as `refs: []`. An empty window is an answer;
   * this is the absence of one, and it is what tells `FallbackSource` that going
   * somewhere else is warranted rather than a way of papering over a quiet month.
   */
  unreadable?: string;
}

export interface Source {
  readonly key: string;
  /**
   * The parliament this adapter is pinned to, when it is pinned to one. An
   * adapter covering several Länder leaves it out rather than naming a
   * placeholder: every ref it yields carries its own `parliament`, so there is
   * nothing to fall back to.
   */
  readonly parliament?: ParliamentKey;
  /** The tier the pipeline runs for documents from this source. */
  readonly tier: Tier;
  readonly label: string;
  /** Where a human can see the same data. */
  readonly homepage: string;
  /** What is genuinely specific about this source — quirks worth knowing. */
  readonly notes: string;
  /** Environment variable holding this source's credential, when it needs one. */
  readonly apiKeyEnv?: string;
  /**
   * A politeness floor for this source, in milliseconds between requests to one
   * host. Sources that reach a server which has asked not to be crawled set it
   * well above the default: if the operator has decided to fetch anyway, the least
   * the tool can do is go slowly.
   */
  readonly minHostIntervalMs?: number;
  /** Rule sets to use for segmentation; the shared default when omitted. */
  readonly ruleSets?: readonly SegmentationRules[];
  discover(options: DiscoverOptions): Promise<DiscoverResult>;
}

/**
 * Rebuild a `DiscoverResult` around new refs, carrying the discovery bookkeeping
 * across unchanged.
 *
 * Every adapter that wraps another one ends the same way, and five of them wrote
 * this out by hand — Niedersachsen had already extracted it privately, which is
 * how you can tell the abstraction was wanted. Adding one optional field to
 * `DiscoverResult` meant five edits, and forgetting one would have dropped that
 * field for that Land silently.
 *
 * Note what this does *not* do: it never re-applies `applyWindow`. The wrapped
 * adapter has already filtered to the window, and filtering twice on a ref whose
 * date the wrapper enriched would quietly change which records a sync returns.
 */
export function withDiscoveryState(
  discovered: DiscoverResult,
  refs: DocRef[],
  warnings: string[] = discovered.warnings,
): DiscoverResult {
  const result: DiscoverResult = { refs, warnings };
  if (discovered.state !== undefined) result.state = discovered.state;
  if (discovered.unchanged !== undefined) result.unchanged = discovered.unchanged;
  return result;
}

/**
 * Keep only refs inside the requested date window and period, in a stable order.
 *
 * The window is on the date the Anfrage was **asked**. That is the Anfrage's own
 * date, it is what every upstream filters on, and using the answer's date instead
 * makes a window silently exclude the records it was meant to include — a question
 * asked in June is often answered in August.
 */
export function applyWindow(refs: DocRef[], options: DiscoverOptions): DocRef[] {
  const filtered = refs.filter((ref) => {
    const date = ref.dates.submitted ?? ref.dates.answered;
    if (options.since !== undefined && (date === undefined || date < options.since)) return false;
    if (options.until !== undefined && (date === undefined || date > options.until)) return false;
    if (options.period !== undefined && ref.legislative_period !== options.period) return false;
    return true;
  });
  filtered.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return options.limit === undefined ? filtered : filtered.slice(0, options.limit);
}

/** How far a parliament's adapter has got. */
export type SourceStatus = "implemented" | "via_aggregator" | "planned";

/**
 * A connector's own description of itself, for the registry and `ka sources list`.
 *
 * It lives here rather than in the registry so that a connector can declare it
 * without importing the package that collects it — the registry depends on every
 * connector, so the arrow cannot point both ways.
 */
export interface SourceEntry {
  key: string;
  /** Absent for an adapter that is not tied to one parliament. */
  parliament?: ParliamentKey;
  label: string;
  status: SourceStatus;
  /** Why it is in this state, in one line. */
  note: string;
  /** Present only for an entry that can actually be built. */
  factory?: () => Source;
}

/**
 * Compose a parliament's own interface with the aggregator behind it.
 *
 * The Parlamentsspiegel is a third party. It is an excellent one — the Landtag NRW
 * runs it for all sixteen Länder — but a record about Sachsen should come from
 * Sachsen where Sachsen offers a way to get it. So a connector that has both routes
 * puts its own first and keeps the aggregator as a fallback.
 *
 * The fallback triggers on two things and not on a third:
 *
 * * the primary **throws** — the host is down, the certificate expired, the API
 *   moved;
 * * the primary reports `unreadable` — it reached its source and did not recognise
 *   what came back, which is how a scraper says its markup contract broke.
 *
 * It does **not** trigger on zero refs. An empty window is a legitimate answer, and
 * a Land that published nothing in March must not be quietly backfilled from
 * somewhere else. Nor does it trigger on a `UsageError`: that is the primary saying
 * the *request* cannot be honoured as typed — a window on a feed that carries no
 * dates — and answering it from somewhere else would honour a request the operator
 * was just told is not answerable here. That distinction is the same one `ApiReading` draws in the
 * Thüringen client: "there is nothing" and "I do not understand this" are different
 * facts, and only one of them is a reason to go looking elsewhere.
 *
 * Which route produced the refs is always in `warnings`, because a record's
 * provenance should never be something the operator has to infer.
 */
export class FallbackSource implements Source {
  constructor(
    private readonly primary: Source,
    private readonly fallback: Source,
  ) {}

  get key(): string {
    return this.primary.key;
  }
  get parliament(): ParliamentKey | undefined {
    return this.primary.parliament;
  }
  get tier(): Tier {
    return this.primary.tier;
  }
  get label(): string {
    return this.primary.label;
  }
  get homepage(): string {
    return this.primary.homepage;
  }
  get notes(): string {
    return `${this.primary.notes} Falls back to ${this.fallback.label} when this interface cannot be read.`;
  }
  get apiKeyEnv(): string | undefined {
    return this.primary.apiKeyEnv;
  }
  get ruleSets(): readonly SegmentationRules[] | undefined {
    return this.primary.ruleSets;
  }

  async discover(options: DiscoverOptions): Promise<DiscoverResult> {
    let reason: string;
    try {
      const result = await this.primary.discover(options);
      if (result.unreadable === undefined) return result;
      reason = result.unreadable;
    } catch (err) {
      if (err instanceof UsageError) throw err;
      reason = err instanceof Error ? err.message : String(err);
    }
    const result = await this.fallback.discover(options);
    return {
      ...result,
      warnings: [
        `${this.primary.key}: ${reason} — fell back to ${this.fallback.key}, ` +
          "so these records came from the aggregator rather than from the parliament itself",
        ...result.warnings,
      ],
    };
  }
}


/**
 * Ask a server's robots.txt whether we may fetch from it.
 *
 * The file is read at run time rather than baked into a connector, so a Land that
 * lifts its `Disallow: /` stops blocking us the same day — and one that adds a rule
 * starts being honoured the same day. A server with no robots.txt allows
 * everything, which is what a 404 there means.
 */
export async function robotsGate(
  engine: FetchEngine,
  options: { origin: string; path: string; ignoreRobots?: boolean },
): Promise<{ allowed: boolean; overridden: boolean; note?: string }> {
  let rules = NO_RULES;
  try {
    const response = await engine.get(`${options.origin}/robots.txt`, { headers: { accept: "text/plain" } });
    rules = parseRobots(response.body.toString("utf8"));
  } catch {
    // No robots.txt, or it could not be read. Neither is a prohibition, and
    // inventing one would block a server that never asked to be left alone.
    rules = NO_RULES;
  }
  if (isAllowed(rules, DEFAULT_USER_AGENT, options.path)) return { allowed: true, overridden: false };
  if (options.ignoreRobots === true) {
    return {
      allowed: true,
      overridden: true,
      note:
        `${options.origin} disallows ${options.path} in its robots.txt, and --ignore-robots was given, ` +
        "so these documents were fetched anyway — the decision and its consequences are the operator's",
    };
  }
  return {
    allowed: false,
    overridden: false,
    note:
      `${options.origin} disallows ${options.path} in its robots.txt, so its documents were not fetched. ` +
      "The records exist and are public; pass --ignore-robots to fetch them anyway, and read " +
      "the connector's README first — it says what is known about this Land's position.",
  };
}
