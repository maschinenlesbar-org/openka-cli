// The fetch engine: URL building, retry/backoff, redirects, conditional requests
// and per-host rate limiting. One place, shared by every source client, so "being
// a good citizen" (CONCEPT.md §7) is a property of the line rather than something
// each adapter has to remember.

import {
  NetworkError,
  OpenKaApiError,
  assertValid,
  intRangeProblem,
  nonBlankProblem,
  type Problem,
} from "@maschinenlesbar.org/openka-lib-errors";
import { stripControlCharacters } from "@maschinenlesbar.org/openka-lib-text";
import { buildQuery, type QueryParams } from "./query.js";
import { MAX_TIMEOUT_MS, nodeHttpTransport, type Transport } from "./http.js";

export const DEFAULT_USER_AGENT =
  "openka-cli (+https://github.com/maschinenlesbar-org/openka-cli)";

/** Default per-request timeout. Parliament sites are not fast. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** 64 MiB — a Landtag PDF is rarely over 20 MiB, a Wahlperiode XML export can be 60. */
export const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

/** Retries of a transient failure when none is set. */
export const DEFAULT_MAX_RETRIES = 3;
/** The most retries an engine takes: past this, retrying is hammering a server that is down. */
export const MAX_RETRIES = 10;
/** Redirects followed when none is set. */
export const DEFAULT_MAX_REDIRECTS = 5;
/** The most redirects an engine follows; a longer chain is a loop or a trap. */
export const MAX_REDIRECTS = 10;
/** Minimum milliseconds between two requests to one host when none is set. */
export const DEFAULT_MIN_HOST_INTERVAL_MS = 500;
/** The longest engine-wide interval: a minute between requests is already a crawl at walking pace. */
export const MAX_HOST_INTERVAL_MS = 60_000;
/** The smallest response cap: below a kilobyte not even an error page fits. */
export const MIN_RESPONSE_BYTES = 1024;

/**
 * Why `value` cannot be sent as the User-Agent, or `undefined` when it can. It is
 * what a robots.txt rule is matched against and how a parliament's operator finds
 * us (CONCEPT.md §7), so it may not be blank; and it is a header value, so CR/LF
 * (header injection), other control characters and anything above U+00FF — which
 * Node refuses with a raw TypeError mid-request — are refused up front.
 */
export const userAgentProblem: Problem<string> = (value) => {
  const blank = nonBlankProblem(value);
  if (blank !== undefined) return blank;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if ((code < 0x20 && code !== 0x09) || code === 0x7f || code > 0xff) {
      return "Expected a header value: no control characters, nothing above U+00FF.";
    }
  }
  return undefined;
};

/**
 * Check the engine options a caller set; an omitted one keeps its default. Throws
 * `OpenKaValidationError`: `timeoutMs` 0–`MAX_TIMEOUT_MS`, `maxRetries`
 * 0–`MAX_RETRIES`, `maxRedirects` 0–`MAX_REDIRECTS`, `minHostIntervalMs`
 * 0–`MAX_HOST_INTERVAL_MS`, `maxResponseBytes` >= `MIN_RESPONSE_BYTES`, all
 * integers; `userAgent` per `userAgentProblem`. `maxRetries: -1` used to make no
 * request at all and fail with "NetworkError: undefined", `25` sent 26 requests to
 * a server answering 503, and a blank User-Agent went out as an empty header.
 */
export function assertEngineOptions(options: EngineOptions): void {
  const check = (name: keyof EngineOptions, problem: Problem<number>): void => {
    const value = options[name];
    if (value !== undefined) assertValid(name, value as number, problem);
  };
  check("timeoutMs", intRangeProblem(0, MAX_TIMEOUT_MS));
  check("maxRetries", intRangeProblem(0, MAX_RETRIES));
  check("maxRedirects", intRangeProblem(0, MAX_REDIRECTS));
  check("minHostIntervalMs", intRangeProblem(0, MAX_HOST_INTERVAL_MS));
  check("maxResponseBytes", intRangeProblem(MIN_RESPONSE_BYTES));
  if (options.userAgent !== undefined) assertValid("userAgent", options.userAgent, userAgentProblem);
}

/** Headers that must never travel to a different host on a redirect. */
const SENSITIVE_HEADERS = ["authorization", "x-api-key", "cookie"];

export interface EngineOptions {
  baseUrl?: string;
  timeoutMs?: number;
  userAgent?: string;
  maxRetries?: number;
  maxResponseBytes?: number;
  /** Redirects followed before giving up. 0 surfaces a 3xx as an error. */
  maxRedirects?: number;
  /** Minimum milliseconds between two requests to the same host. */
  minHostIntervalMs?: number;
  transport?: Transport;
  /** Injectable clock and sleep, so retry/rate-limit behaviour is testable. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * When each host was last asked, shared with other engines. Unset, the engine
   * keeps its own. Engines that share one never send two requests to one host
   * closer together than the interval of the engine sending the second — what lets
   * `ka sync` run several sources at once without doubling the load on a host they
   * both reach, such as the Parlamentsspiegel.
   */
  pacer?: HostPacer;
}

/**
 * The per-host pacing book: when each host was last asked, and a queue per host so
 * that requests to one host are spaced out one after another even when several
 * callers (engines, or concurrent requests of one engine) want it at once.
 */
export class HostPacer {
  private readonly lastRequestAt = new Map<string, number>();
  private readonly queues = new Map<string, Promise<void>>();
  /**
   * Per-host floors raised during the run (`FetchEngine.slowDown`), for every engine
   * on this pacer. A floor kept per engine let a second source of the same run ask a
   * host 500 ms after the first source had been slowed to 4 s on it.
   */
  private readonly floors = new Map<string, number>();

  /** Never go faster than `ms` on `host` again, whichever engine asks. Only raises. */
  raiseFloor(host: string, ms: number): void {
    this.floors.set(host, Math.max(ms, this.floors.get(host) ?? 0));
  }

  /** The floor raised for `host` so far (0 when none). */
  floorFor(host: string): number {
    return this.floors.get(host) ?? 0;
  }

  /**
   * Wait for `host`'s turn: after every earlier caller, and at least `intervalMs`
   * after the last request to it. Records the request either way, so an engine
   * with no interval still counts for one that has one.
   */
  async wait(host: string, intervalMs: number, clock: { now: () => number; sleep: (ms: number) => Promise<void> }): Promise<void> {
    const previous = this.queues.get(host) ?? Promise.resolve();
    let done!: () => void;
    const mine = new Promise<void>((resolve) => (done = resolve));
    const tail = previous.then(() => mine);
    this.queues.set(host, tail);
    await previous;
    try {
      const last = this.lastRequestAt.get(host);
      if (intervalMs > 0 && last !== undefined) {
        const wait = last + intervalMs - clock.now();
        if (wait > 0) await clock.sleep(wait);
      }
      this.lastRequestAt.set(host, clock.now());
    } finally {
      done();
      if (this.queues.get(host) === tail) this.queues.delete(host);
    }
  }
}

/** Reject a base URL that is not http(s), before any request is built. */
export function assertHttpScheme(baseUrl: string): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new NetworkError(`Invalid base URL: ${baseUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new NetworkError(`Unsupported protocol "${url.protocol}" in base URL: ${baseUrl}`);
  }
}

/**
 * Strip the characters a terminal would act on from server-supplied text before it
 * reaches stderr. Upstream text (a Content-Type, an error body) is untrusted.
 *
 * The trim is this function's own: a server body arrives padded with the newlines
 * that framed it, and an error message should not start with them.
 */
export function sanitizeServerText(text: string): string {
  return stripControlCharacters(text, { keepWhitespace: false }).trim();
}

/** Asked before a redirect is followed, with the absolute target; a throw refuses the hop. */
export type RedirectHook = (url: string) => void | Promise<void>;

/** Conditional-request state a caller can hand back on the next run. */
export interface CacheValidators {
  etag?: string;
  last_modified?: string;
}

export interface FetchResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  /** True when the server answered 304 and `body` is empty. */
  notModified: boolean;
  etag?: string;
  lastModified?: string;
  contentType?: string;
  /** The URL the bytes actually came from, after any redirects. */
  finalUrl: string;
}

export class FetchEngine {
  private readonly baseUrl: string | undefined;
  private readonly timeoutMs: number;
  /** The User-Agent every request carries — what a robots.txt rule is matched against. */
  readonly userAgent: string;
  private readonly maxRetries: number;
  private readonly maxResponseBytes: number;
  private readonly maxRedirects: number;
  /** Engine-wide interval: the option, raised by any floor a caller set since (`raiseMinHostInterval`). */
  private minHostIntervalMs: number;
  private readonly transport: Transport;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pacer: HostPacer;
  /** Per-host floors raised during a run, above the engine-wide minimum. */
  private readonly hostIntervals = new Map<string, number>();

  /** Throws `OpenKaValidationError` for an option out of range (`assertEngineOptions`). */
  constructor(options: EngineOptions = {}) {
    assertEngineOptions(options);
    this.baseUrl = options.baseUrl?.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    this.minHostIntervalMs = options.minHostIntervalMs ?? DEFAULT_MIN_HOST_INTERVAL_MS;
    this.transport = options.transport ?? nodeHttpTransport;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
    this.pacer = options.pacer ?? new HostPacer();
    if (this.baseUrl !== undefined) assertHttpScheme(this.baseUrl);
  }

  /** Resolve a path (or absolute URL) plus params against the configured base. */
  url(pathOrUrl: string, params: QueryParams = {}): string {
    const absolute = /^[a-z][a-z0-9+.-]*:/i.test(pathOrUrl);
    let url: string;
    if (absolute) {
      assertHttpScheme(pathOrUrl);
      url = pathOrUrl;
    } else {
      if (this.baseUrl === undefined) throw new NetworkError(`No base URL configured for path ${pathOrUrl}`);
      url = `${this.baseUrl}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;
    }
    const query = buildQuery(params);
    if (query === "") return url;
    return url + (url.includes("?") ? "&" : "?") + query;
  }

  /**
   * GET a URL, honouring rate limits, retries, redirects and conditional requests.
   * A 304 comes back as `notModified` rather than an error, because "unchanged" is
   * the common and cheap case the pipeline is built around.
   */
  async get(
    pathOrUrl: string,
    options: {
      params?: QueryParams;
      headers?: Record<string, string>;
      validators?: CacheValidators;
      /** Fewer retries than the engine's for this request (never more): robots.txt asks once more at most. */
      maxRetries?: number;
      /** Called with each redirect target before it is requested; throw to refuse the hop. */
      onRedirect?: RedirectHook;
    } = {},
  ): Promise<FetchResult> {
    const target = this.url(pathOrUrl, options.params ?? {});
    const headers: Record<string, string> = {
      "user-agent": this.userAgent,
      "accept-encoding": "identity",
      ...(options.headers ?? {}),
    };
    if (options.validators?.etag) headers["if-none-match"] = options.validators.etag;
    if (options.validators?.last_modified) headers["if-modified-since"] = options.validators.last_modified;
    const retries = options.maxRetries === undefined ? undefined : Math.min(Math.max(0, Math.trunc(options.maxRetries)), this.maxRetries);
    return this.request("GET", target, headers, undefined, retries, options.onRedirect);
  }

  /**
   * HEAD a URL: does this document exist, without downloading it.
   *
   * It is here for the case where a *path* carries a fact. Bayern files its
   * Drucksachen under `…/Drucksachen/Schriftliche Anfragen/19_0013327.pdf`, so a
   * 200 there is proof that the paper is a Schriftliche Anfrage and a 404 is proof
   * that it is not — which is how that connector tells one instrument from another
   * without guessing and without pulling half a megabyte per candidate.
   *
   * Unlike `get`, a 404 is returned rather than thrown: absence is the answer being
   * asked for.
   */
  async head(
    pathOrUrl: string,
    options: { params?: QueryParams; headers?: Record<string, string>; onRedirect?: RedirectHook } = {},
  ): Promise<{ status: number; headers: FetchResult["headers"] }> {
    const target = this.url(pathOrUrl, options.params ?? {});
    const headers: Record<string, string> = {
      "user-agent": this.userAgent,
      "accept-encoding": "identity",
      ...(options.headers ?? {}),
    };
    try {
      const result = await this.request("HEAD", target, headers, undefined, this.maxRetries, options.onRedirect);
      return { status: result.status, headers: result.headers };
    } catch (err) {
      // A 404 is the answer, not a failure: the caller is asking whether the
      // document is there. Anything else is a real problem and still throws.
      if (err instanceof OpenKaApiError && err.status === 404) return { status: 404, headers: {} };
      throw err;
    }
  }

  /**
   * POST a body. Only one source needs this — Thüringen's Parlamentsdatenbank
   * drives its search from a JSON API rather than a GET form — and it goes through
   * the same retry, redirect and rate-limiting path as everything else, so being a
   * good citizen is not something that adapter has to remember.
   */
  async post(
    pathOrUrl: string,
    options: { body: string; contentType?: string; params?: QueryParams; headers?: Record<string, string> } = {
      body: "",
    },
  ): Promise<FetchResult> {
    const target = this.url(pathOrUrl, options.params ?? {});
    const headers: Record<string, string> = {
      "user-agent": this.userAgent,
      "accept-encoding": "identity",
      "content-type": options.contentType ?? "application/x-www-form-urlencoded; charset=UTF-8",
      ...(options.headers ?? {}),
    };
    return this.request("POST", target, headers, options.body);
  }

  private async request(
    startMethod: string,
    startUrl: string,
    headers: Record<string, string>,
    startBody?: string,
    maxRetries: number = this.maxRetries,
    onRedirect?: RedirectHook,
  ): Promise<FetchResult> {
    let url = startUrl;
    let method = startMethod;
    let body = startBody;
    let currentHeaders = headers;

    for (let hop = 0; ; hop++) {
      const response = await this.attempt(method, url, currentHeaders, body, maxRetries);
      const status = response.status;

      if (status >= 300 && status < 400 && status !== 304) {
        const location = firstHeader(response.headers["location"]);
        if (location === undefined) {
          throw new OpenKaApiError({ status, url, method, body: bodyPreview(response.body) });
        }
        if (hop >= this.maxRedirects) {
          throw new NetworkError(`Too many redirects (> ${this.maxRedirects}) starting at ${startUrl}`);
        }
        const next = new URL(location, url);
        assertHttpScheme(next.toString());
        // Credentials never cross an *origin* boundary, whatever the upstream asks
        // for. Comparing origins rather than hosts matters because a same-host
        // redirect from https: to http: is still a credential leak — the API key
        // would go out in clear text to anyone on the path.
        if (next.origin !== new URL(url).origin) currentHeaders = withoutSensitiveHeaders(currentHeaders);
        // RFC 9110 §15.4: a 303 is followed with GET, and 301/302 are too by every
        // client in practice; only 307/308 keep the method. Re-POSTing a STARWEB
        // form to the results page it redirected to would be answered with the
        // search form again — the same silent failure a wrong `__action` gives.
        if ((status === 301 || status === 302 || status === 303) && method !== "GET" && method !== "HEAD") {
          method = "GET";
          body = undefined;
          currentHeaders = withoutBodyHeaders(currentHeaders);
        }
        url = next.toString();
        // The caller's rules (robots.txt) are about every URL requested, not just the
        // first: a redirect into a disallowed path or onto another host was fetched
        // with no check at all (exploratory test 2026-10-07).
        if (onRedirect !== undefined) await onRedirect(url);
        continue;
      }

      if (status === 304) {
        return {
          status,
          headers: response.headers,
          body: Buffer.alloc(0),
          notModified: true,
          finalUrl: url,
          ...validatorsOf(response.headers),
        };
      }

      if (status < 200 || status >= 300) {
        throw new OpenKaApiError({ status, url, method, body: bodyPreview(response.body) });
      }

      const contentType = firstHeader(response.headers["content-type"]);
      const result: FetchResult = {
        status,
        headers: response.headers,
        body: response.body,
        notModified: false,
        finalUrl: url,
        ...validatorsOf(response.headers),
      };
      if (contentType !== undefined) result.contentType = contentType;
      return result;
    }
  }

  /** One URL, with rate limiting, retry and `Retry-After` handling. */
  private async attempt(
    method: string,
    url: string,
    headers: Record<string, string>,
    body?: string,
    maxRetries: number = this.maxRetries,
  ): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
    let lastError: unknown;
    let timeouts = 0;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      await this.throttle(url);
      try {
        const response = await this.transport({
          method,
          url,
          headers,
          ...(body === undefined ? {} : { body }),
          timeoutMs: this.timeoutMs,
          maxResponseBytes: this.maxResponseBytes,
        });
        if ((response.status === 429 || response.status === 503) && attempt < maxRetries) {
          await this.sleep(retryDelayMs(response.headers["retry-after"], attempt));
          continue;
        }
        return response;
      } catch (err) {
        lastError = err;
        if (attempt >= maxRetries) break;
        // Every failure used to be retried maxRetries times: an over-size body was
        // downloaded four times (4 × 64 MiB per document on a parliament server)
        // and a hanging host cost four timeouts plus backoff. A size or URL
        // failure is deterministic and is not retried; a timeout is retried once.
        const failure = err instanceof NetworkError ? err.failure : undefined;
        if (failure === "too_large" || failure === "bad_url") break;
        if (failure === "timeout" && ++timeouts > 1) break;
        await this.sleep(retryDelayMs(undefined, attempt));
      }
    }
    // The loop always runs once (maxRetries >= 0) and leaves only through a
    // caught failure, so lastError is set; the fallback still names the request
    // rather than reading "undefined".
    throw lastError instanceof Error ? lastError : new NetworkError(`${method} ${url} failed: ${String(lastError ?? "no attempt was made")}`);
  }

  /**
   * Go no faster than `ms` between requests to `host` from now on. Only ever raises
   * the floor: a host that asked not to be crawled and is fetched anyway is
   * slowed to the rate the override policy names, whatever the global setting.
   */
  slowDown(host: string, ms: number): void {
    this.hostIntervals.set(host, Math.max(ms, this.hostIntervals.get(host) ?? 0));
    this.pacer.raiseFloor(host, ms);
  }

  /**
   * Go no faster than `ms` between two requests to any one host, from now on. Only
   * ever raises the engine-wide interval, never lowers it: a source's politeness
   * floor (`Source.minHostIntervalMs`) covers every host it reaches, which is not
   * known in advance (an aggregator for discovery, a Land's server for the
   * documents). `sync()` calls it with the source's floor. Throws
   * `OpenKaValidationError` for a value the `minHostIntervalMs` option refuses.
   */
  raiseMinHostInterval(ms: number): void {
    assertValid("minHostIntervalMs", ms, intRangeProblem(0, MAX_HOST_INTERVAL_MS));
    this.minHostIntervalMs = Math.max(this.minHostIntervalMs, ms);
  }

  /** Keep at least the host's interval between two requests to the same host. */
  private async throttle(url: string): Promise<void> {
    const host = new URL(url).host;
    const interval = Math.max(this.minHostIntervalMs, this.hostIntervals.get(host) ?? 0, this.pacer.floorFor(host));
    await this.pacer.wait(host, interval, { now: this.now, sleep: this.sleep });
  }
}

function withoutSensitiveHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!SENSITIVE_HEADERS.includes(key.toLowerCase())) out[key] = value;
  }
  return out;
}

/** Headers that describe a request body, dropped when a redirect drops the body. */
function withoutBodyHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower !== "content-type" && lower !== "content-length") out[key] = value;
  }
  return out;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

function validatorsOf(headers: Record<string, string | string[] | undefined>): {
  etag?: string;
  lastModified?: string;
} {
  const out: { etag?: string; lastModified?: string } = {};
  const etag = firstHeader(headers["etag"]);
  const lastModified = firstHeader(headers["last-modified"]);
  if (etag !== undefined) out.etag = etag;
  if (lastModified !== undefined) out.lastModified = lastModified;
  return out;
}

function bodyPreview(body: Buffer): string {
  return sanitizeServerText(body.subarray(0, 2048).toString("utf8"));
}

/** Linear backoff, overridden by a `Retry-After` the server sent. Capped at 60s. */
export function retryDelayMs(retryAfter: string | string[] | undefined, attempt: number): number {
  // A blank header is no header. `Number("")` is 0, so an empty `Retry-After` used
  // to mean "retry immediately" and turned the backoff off entirely for all three
  // attempts — the opposite of what a 429 is asking for.
  //
  // Only the two forms RFC 9110 defines are read: delay-seconds (digits only) and
  // an IMF-fixdate. `Number()` took "0x10" as 16 s and "1e9" as a billion, and
  // `Date.parse("-5")` is the year −5, so a negative value meant "retry now".
  // Anything else falls back to the linear backoff.
  const header = firstHeader(retryAfter)?.trim();
  if (header !== undefined && header !== "") {
    if (/^\d+$/.test(header)) return Math.min(Number(header) * 1000, 60_000);
    if (IMF_FIXDATE.test(header)) {
      const date = Date.parse(header);
      if (Number.isFinite(date)) return Math.min(Math.max(0, date - Date.now()), 60_000);
    }
  }
  return Math.min((attempt + 1) * 1000, 60_000);
}

/** RFC 9110's preferred HTTP-date, the only date form `Retry-After` is read in. */
const IMF_FIXDATE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;
