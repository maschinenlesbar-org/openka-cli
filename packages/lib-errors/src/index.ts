// Error types raised across the line. Kept free of I/O so they are trivial to
// construct in tests and to `instanceof`-check by library consumers.

/** Base class for every error originating from OpenKA. */
export class OpenKaError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** An upstream source responded with a non-2xx status. */
export class OpenKaApiError extends OpenKaError {
  readonly status: number;
  readonly url: string;
  readonly method: string;
  readonly body: string;

  constructor(args: { status: number; url: string; method: string; body: string }) {
    super(`HTTP ${args.status} for ${args.method} ${args.url}`);
    this.status = args.status;
    this.url = args.url;
    this.method = args.method;
    this.body = args.body;
  }

  /** True for statuses upstreams document as transient and retry-able. */
  get isRetryable(): boolean {
    return this.status === 429 || this.status === 503;
  }
}

/** A transport-level failure (DNS, connection reset, timeout, ...). */
export class NetworkError extends OpenKaError {}

/** A payload could not be parsed as the expected shape. */
export class ParseError extends OpenKaError {}

/** The corpus on disk is missing, unreadable or inconsistent. */
export class StoreError extends OpenKaError {}

/**
 * A combination of options that cannot be honoured. Exits 2, like a parse error,
 * because the alternative — running anyway and ignoring what was asked — is the
 * silently-dropped constraint this CLI refuses to produce.
 */
export class UsageError extends OpenKaError {}

/**
 * An extractor refused to produce a value it could not derive with certainty.
 * Carrying this as an error type (rather than a null) keeps "we do not know" from
 * being mistaken for "there is nothing there" anywhere on the line.
 */
export class AbstainError extends OpenKaError {
  readonly field: string;
  readonly reason: string;

  constructor(field: string, reason: string) {
    super(`Abstained on ${field}: ${reason}`);
    this.field = field;
    this.reason = reason;
  }
}
