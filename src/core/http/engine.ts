// The fetch engine: URL building, retry/backoff, redirects, conditional requests
// and per-host rate limiting. One place, shared by every source client, so "being
// a good citizen" (CONCEPT.md §7) is a property of the line rather than something
// each adapter has to remember.

import { NetworkError, OpenKaApiError } from "../errors.js";
import { buildQuery, type QueryParams } from "./query.js";
import { MAX_TIMEOUT_MS, nodeHttpTransport, type Transport } from "./http.js";

export const DEFAULT_USER_AGENT =
  "openka-cli (+https://github.com/maschinenlesbar-org/openka-cli)";

/** Default per-request timeout. Parliament sites are not fast. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** 64 MiB — a Landtag PDF is rarely over 20 MiB, a Wahlperiode XML export can be 60. */
export const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

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
 */
export function sanitizeServerText(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : ch;
  }
  return out.trim();
}

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
  private readonly userAgent: string;
  private readonly maxRetries: number;
  private readonly maxResponseBytes: number;
  private readonly maxRedirects: number;
  private readonly minHostIntervalMs: number;
  private readonly transport: Transport;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly lastRequestAt = new Map<string, number>();

  constructor(options: EngineOptions = {}) {
    this.baseUrl = options.baseUrl?.replace(/\/+$/, "");
    this.timeoutMs = Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.maxRetries = options.maxRetries ?? 3;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.maxRedirects = options.maxRedirects ?? 5;
    this.minHostIntervalMs = options.minHostIntervalMs ?? 500;
    this.transport = options.transport ?? nodeHttpTransport;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
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
    options: { params?: QueryParams; headers?: Record<string, string>; validators?: CacheValidators } = {},
  ): Promise<FetchResult> {
    const target = this.url(pathOrUrl, options.params ?? {});
    const headers: Record<string, string> = {
      "user-agent": this.userAgent,
      "accept-encoding": "identity",
      ...(options.headers ?? {}),
    };
    if (options.validators?.etag) headers["if-none-match"] = options.validators.etag;
    if (options.validators?.last_modified) headers["if-modified-since"] = options.validators.last_modified;
    return this.request("GET", target, headers);
  }

  private async request(
    method: string,
    startUrl: string,
    headers: Record<string, string>,
  ): Promise<FetchResult> {
    let url = startUrl;
    let currentHeaders = headers;

    for (let hop = 0; ; hop++) {
      const response = await this.attempt(method, url, currentHeaders);
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
        // Credentials never cross a host boundary, whatever the upstream asks for.
        if (next.host !== new URL(url).host) currentHeaders = withoutSensitiveHeaders(currentHeaders);
        url = next.toString();
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
  ): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      await this.throttle(url);
      try {
        const response = await this.transport({
          method,
          url,
          headers,
          timeoutMs: this.timeoutMs,
          maxResponseBytes: this.maxResponseBytes,
        });
        if ((response.status === 429 || response.status === 503) && attempt < this.maxRetries) {
          await this.sleep(retryDelayMs(response.headers["retry-after"], attempt));
          continue;
        }
        return response;
      } catch (err) {
        lastError = err;
        if (attempt >= this.maxRetries) break;
        await this.sleep(retryDelayMs(undefined, attempt));
      }
    }
    throw lastError instanceof Error ? lastError : new NetworkError(String(lastError));
  }

  /** Keep at least `minHostIntervalMs` between two requests to the same host. */
  private async throttle(url: string): Promise<void> {
    if (this.minHostIntervalMs <= 0) return;
    const host = new URL(url).host;
    const last = this.lastRequestAt.get(host);
    const now = this.now();
    if (last !== undefined) {
      const wait = last + this.minHostIntervalMs - now;
      if (wait > 0) await this.sleep(wait);
    }
    this.lastRequestAt.set(host, this.now());
  }
}

function withoutSensitiveHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!SENSITIVE_HEADERS.includes(key.toLowerCase())) out[key] = value;
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
  const header = firstHeader(retryAfter);
  if (header !== undefined) {
    const seconds = Number(header.trim());
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.min(Math.max(0, date - Date.now()), 60_000);
  }
  return Math.min((attempt + 1) * 1000, 60_000);
}
