// The Source protocol — the "set of clients" layer.
//
// A source knows three things and nothing else: where its parliament publishes,
// how to page through that publication, and which URLs belong to one Anfrage. It
// does not extract: extraction is shared, deterministic and parameterised by the
// tier the source declares. Keeping adapters this thin is what stops a redesign at
// one Landtag from turning into a rewrite.

import type { KaRecord, ParliamentKey } from "@maschinenlesbar.org/openka-lib-models";
import { OpenKaApiError, OpenKaError, UsageError } from "@maschinenlesbar.org/openka-lib-errors";
import { NO_RULES, isAllowed, parseRobots, type RobotsRules } from "@maschinenlesbar.org/openka-lib-robots";
import type {
  AnsweredBy,
  Asker,
  Dates,
  DocumentType,
  SourceDocumentRole,
  Tier,
} from "@maschinenlesbar.org/openka-lib-models";
import { DEFAULT_MIN_HOST_INTERVAL_MS, type FetchEngine } from "@maschinenlesbar.org/openka-lib-http";
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
   * is not silent — the run warns, once per host, that it was used. The records do
   * not carry that warning.
   */
  ignoreRobots?: boolean;
  /**
   * The run's robots.txt policy, when the caller has one. A connector that gates its
   * discovery on a document server (`robotsGate`) asks this one, so the pipeline's
   * later per-document checks reuse the same reading of the file: one robots.txt
   * request per host per run, and no chance of two different answers in one run.
   */
  robots?: RobotsPolicy;
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
  /**
   * Set when the source did not look at all, and why — a gated connector whose
   * documents its host's robots.txt disallows, without --ignore-robots. Not an empty
   * window either: a daily `ka sync` has to be able to tell "blocked" from "nothing
   * new", and the run is not recorded as a sync.
   */
  blocked?: string;
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
  /** Why the source sets `minHostIntervalMs`, for `ka sources show` and the sync's note. */
  readonly minHostIntervalReason?: string;
  /** Rule sets to use for segmentation; the shared default when omitted. */
  readonly ruleSets?: readonly SegmentationRules[];
  discover(options: DiscoverOptions): Promise<DiscoverResult>;
  /**
   * How many Anfragen the upstream holds, asked with a request or two and no
   * discovery — what `ka sources count` sets beside the corpus. Optional: a source
   * that could only count by discovering everything leaves it out. A `period` the
   * upstream cannot count by is a `UsageError`, not a number for something else.
   */
  count?(options: CountOptions): Promise<UpstreamCount>;
  /**
   * Whether an extracted record is the paper its ref names: a reason when it is not,
   * else `undefined`. The pipeline then stores nothing for the ref and reports the
   * reason. Optional, because only some Länder print their Drucksachennummer in one
   * form a source can rely on; a record is never changed by it, so `ka verify` and the
   * extractor version are untouched.
   */
  checkRecord?(ref: DocRef, record: KaRecord): string | undefined;
}

export interface CountOptions {
  engine: FetchEngine;
  /** Count only this legislative period. */
  period?: number;
  /** Credential for a source that needs one, already resolved from flag or env. */
  apiKey?: string;
}

export interface UpstreamCount {
  /** Anfragen the upstream says it holds. */
  total: number;
  /** Where the number comes from, for the reader: "DIP numFound", "Parlamentsspiegel". */
  basis: string;
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
 *
 * A ref that carries only the answer's date — a combined paper's row — is placed
 * at that date. That is a stand-in, not the question's date: such a ref answered
 * after `until` is left out although its question may fall inside. Widening the
 * window catches those, while including every one of them would fetch every paper
 * answered since `since`. `sync()` says how many refs were placed this way, and the
 * corpus's own date filters (`--from`/`--to`, `--year`) use only the question's date.
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
  /** The Land's papers are the same papers whichever path found them. */
  checkRecord(ref: DocRef, record: KaRecord): string | undefined {
    return this.primary.checkRecord?.(ref, record) ?? this.fallback.checkRecord?.(ref, record);
  }
  get apiKeyEnv(): string | undefined {
    return this.primary.apiKeyEnv;
  }
  get ruleSets(): readonly SegmentationRules[] | undefined {
    return this.primary.ruleSets;
  }

  /**
   * The primary's count when it can give one, else the fallback's — and the basis
   * says which, as the warnings do for discovery.
   */
  async count(options: CountOptions): Promise<UpstreamCount> {
    const counter = this.primary.count !== undefined ? this.primary : this.fallback;
    if (counter.count === undefined) {
      throw new OpenKaError(`${this.primary.key} cannot count its upstream without discovering it`);
    }
    return counter.count(options);
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
        // Named by its label: the aggregator source carries the Land's own key (state is
        // stored under it), so "fell back to mecklenburg-vorpommern" named nothing.
        `${this.primary.key}: ${reason} — fell back to ${this.fallback.label}, ` +
          "so these records came from the aggregator rather than from the parliament itself",
        ...result.warnings,
      ],
    };
  }
}


/** What a robots.txt check decided about one URL. */
export interface RobotsVerdict {
  allowed: boolean;
  /** True when the rules said no and `--ignore-robots` said fetch anyway. */
  overridden: boolean;
  /** Why, when the answer was not a plain yes — for the operator, once per host. */
  note?: string;
}

/** A request interval for people: "4 s", "0.5 s", "1.25 s". */
function seconds(ms: number): string {
  return `${Number((ms / 1000).toFixed(2))} s`;
}

/**
 * How fast `source` may go, in words — what `ka sources show` prints (issue #24). A
 * source's own floor (`minHostIntervalMs`) is the slowest of the engine's settings,
 * and `--min-host-interval` only ever raises it (`FetchEngine.raiseMinHostInterval`),
 * which nothing used to say: a sync was slow, and the option that looked like the
 * remedy was silently overridden.
 */
export function describeRequestFloor(source: Pick<Source, "minHostIntervalMs" | "minHostIntervalReason">): string {
  const own = source.minHostIntervalMs;
  if (own === undefined || own <= DEFAULT_MIN_HOST_INTERVAL_MS) {
    return `at most one request per ${seconds(DEFAULT_MIN_HOST_INTERVAL_MS)} per host (the default; --min-host-interval changes it)`;
  }
  const why = source.minHostIntervalReason === undefined ? "" : ` — ${source.minHostIntervalReason}`;
  return `at most one request per ${seconds(own)} per host${why}; --min-host-interval can raise this, not lower it`;
}

/**
 * What to tell an operator whose `--min-host-interval` is below `source`'s own floor:
 * the floor wins (`raiseMinHostInterval`), and they should hear so rather than wonder
 * why the option did nothing. Undefined when the option is not below it.
 */
export function floorKeptNote(source: Pick<Source, "key" | "minHostIntervalMs">, requestedMs: number): string | undefined {
  const own = source.minHostIntervalMs;
  if (own === undefined || requestedMs >= own) return undefined;
  return `${source.key}: keeping the source's floor of ${own} ms between requests to a host; --min-host-interval ${requestedMs} can raise it, not lower it`;
}

/**
 * How slowly to go on a host whose robots.txt the operator overrode: one request
 * every four seconds, against a default of 500 ms. A server that asked not to be
 * crawled at all gets the slowest rate this tool offers.
 */
export const ROBOTS_OVERRIDE_INTERVAL_MS = 4000;

/** Retries for a robots.txt request: one, against the engine's usual three. */
export const ROBOTS_MAX_RETRIES = 1;

/**
 * Ask a server's robots.txt whether we may fetch a URL, once per host per run.
 *
 * This is where CONCEPT.md §7 is enforced for *documents*. The two gated
 * connectors check their document server before discovering anything, but a
 * Brandenburg PDF also reaches the pipeline through `--source parlamentsspiegel`,
 * and until this existed that route fetched it with no flag and no warning. The
 * pipeline now asks here before every document request, so the rule holds for
 * whichever door a URL came in by.
 *
 * The file is read at run time rather than baked into a connector, so a Land that
 * lifts its `Disallow: /` stops blocking us the same day — and one that adds a rule
 * starts being honoured the same day. A server with no robots.txt allows
 * everything, which is what a 404 there means. The rules are matched against the
 * User-Agent the engine actually sends, and a host that is fetched under override
 * is slowed to `ROBOTS_OVERRIDE_INTERVAL_MS` for the rest of the run.
 *
 * A robots.txt that cannot be *read* is not a missing one. RFC 9309 §2.3.1.3–4: a
 * 4xx means there is none (fetch freely), but a 5xx or a network failure means the
 * file is undefined and the crawler "MUST assume complete disallow". Treating every
 * failure as permission turned a padoka outage into a full-speed crawl of a server
 * whose file says `Disallow: /` — silently (exploratory test 2026-10-07). A 429 is
 * read like a 5xx: it says "not now", not "no file".
 */
export class RobotsPolicy {
  private readonly rules = new Map<string, Promise<{ rules: RobotsRules; unreadable?: string }>>();

  constructor(
    private readonly engine: FetchEngine,
    private readonly ignoreRobots = false,
  ) {}

  async decide(url: string): Promise<RobotsVerdict> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      // Not ours to judge: the fetch will fail on its own terms.
      return { allowed: true, overridden: false };
    }
    const path = `${parsed.pathname}${parsed.search}`;
    const { rules, unreadable } = await this.rulesFor(parsed.origin);
    if (unreadable !== undefined) return this.unreadableVerdict(parsed, unreadable);
    if (isAllowed(rules, this.engine.userAgent, path)) return { allowed: true, overridden: false };
    if (this.ignoreRobots) {
      this.engine.slowDown(parsed.host, ROBOTS_OVERRIDE_INTERVAL_MS);
      return {
        allowed: true,
        overridden: true,
        note:
          `${parsed.origin} disallows ${path} in its robots.txt, and --ignore-robots was given, ` +
          "so these documents were fetched anyway — the decision and its consequences are the operator's",
      };
    }
    return {
      allowed: false,
      overridden: false,
      note:
        `${parsed.origin} disallows ${path} in its robots.txt, so its documents were not fetched. ` +
        "The records exist and are public; pass --ignore-robots to fetch them anyway, and read " +
        "the connector's README first — it says what is known about this Land's position.",
    };
  }

  /** What to do when the origin's robots.txt could not be read: nothing, unless overridden. */
  private unreadableVerdict(parsed: URL, why: string): RobotsVerdict {
    const file = `${parsed.origin}/robots.txt`;
    if (this.ignoreRobots) {
      this.engine.slowDown(parsed.host, ROBOTS_OVERRIDE_INTERVAL_MS);
      return {
        allowed: true,
        overridden: true,
        note:
          `${file} could not be read (${why}), which RFC 9309 says to treat as disallowing everything; ` +
          "--ignore-robots was given, so these documents were fetched anyway — the decision and its consequences are the operator's",
      };
    }
    return {
      allowed: false,
      overridden: false,
      note:
        `${file} could not be read (${why}), and RFC 9309 says an unreadable robots.txt disallows everything, ` +
        "so its documents were not fetched. Try again later; --ignore-robots fetches them anyway.",
    };
  }

  /**
   * The origin's rules, fetched once and shared by every URL on it. `unreadable`
   * says why there are none to apply when the file could not be read: a 5xx, a 429,
   * a redirect without a target or too many of them, a timeout, a reset, a name
   * that does not resolve.
   */
  private rulesFor(origin: string): Promise<{ rules: RobotsRules; unreadable?: string }> {
    let pending = this.rules.get(origin);
    if (pending === undefined) {
      pending = this.engine
        // One retry at most: a failing server should not be asked four times for a
        // file whose failure already means "fetch nothing".
        .get(`${origin}/robots.txt`, { headers: { accept: "text/plain" }, maxRetries: ROBOTS_MAX_RETRIES })
        .then((response) => ({ rules: parseRobots(response.body.toString("utf8")) }))
        .catch((err: unknown) => {
          // A 4xx other than 429 is "there is no robots.txt": nothing is disallowed,
          // and inventing a prohibition would block a server that never asked.
          if (err instanceof OpenKaApiError && err.status >= 400 && err.status < 500 && err.status !== 429) {
            return { rules: NO_RULES };
          }
          const why = err instanceof OpenKaApiError ? `HTTP ${err.status}` : err instanceof Error ? err.message : String(err);
          return { rules: NO_RULES, unreadable: why };
        });
      this.rules.set(origin, pending);
    }
    return pending;
  }
}

/**
 * A connector asking about its document server before it discovers anything. With
 * the run's `policy` (`DiscoverOptions.robots`) the answer is the one every later
 * document check of the run gets; without one it is a one-shot policy of its own.
 */
export async function robotsGate(
  engine: FetchEngine,
  options: { origin: string; path: string; ignoreRobots?: boolean; policy?: RobotsPolicy },
): Promise<RobotsVerdict> {
  const policy = options.policy ?? new RobotsPolicy(engine, options.ignoreRobots === true);
  return policy.decide(`${options.origin}${options.path}`);
}
