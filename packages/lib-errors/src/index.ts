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

/**
 * What kind of transport failure a `NetworkError` is, where the transport knows.
 * The engine retries on it: a dropped connection is worth another try, a timeout
 * one more, and a response over the size cap or a URL that cannot be fetched at all
 * none — each would fail the same way again, at the same cost.
 */
export type NetworkFailure = "timeout" | "too_large" | "bad_url";

/** A transport-level failure (DNS, connection reset, timeout, ...). */
export class NetworkError extends OpenKaError {
  readonly failure?: NetworkFailure;
  /** For `too_large`: the size the response declared (`Content-Length`), when it did. */
  readonly bytes?: number;

  constructor(message: string, options?: { cause?: unknown; failure?: NetworkFailure; bytes?: number }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    if (options?.failure !== undefined) this.failure = options.failure;
    if (options?.bytes !== undefined) this.bytes = options.bytes;
  }
}

/** A payload could not be parsed as the expected shape. */
export class ParseError extends OpenKaError {}

/** The corpus on disk is missing, unreadable or inconsistent. */
export class StoreError extends OpenKaError {}

/**
 * There is no corpus at `root`: nothing has been synced there. A `StoreError`, so
 * it exits 3 like one; its own class so a CLI can add a hint about where the path
 * came from (`--corpus`, `OPENKA_CORPUS`) without matching on the message.
 */
export class MissingCorpusError extends StoreError {
  readonly root: string;

  constructor(root: string) {
    super(`No corpus at ${root}: nothing has been synced there.`);
    this.root = root;
  }
}

/**
 * Another run is writing to this corpus. A corpus is a directory of plain files,
 * and two writers at once lost index postings and catalog rows silently — both
 * runs reported success. A writer now takes the corpus's lock file first and the
 * second one gets this instead; it exits 3 like any corpus problem.
 */
export class CorpusLockedError extends StoreError {
  readonly lockFile: string;
  /** Who holds it, in words: "sync --source berlin, pid 123 on host". */
  readonly holder: string;

  constructor(lockFile: string, holder: string) {
    super(
      `The corpus is in use by another run (${holder}). Wait for it to finish; if no other ` +
        `run is active, delete ${lockFile}.`,
    );
    this.lockFile = lockFile;
    this.holder = holder;
  }
}

/**
 * A combination of options that cannot be honoured. Exits 2, like a parse error,
 * because the alternative — running anyway and ignoring what was asked — is the
 * silently-dropped constraint this CLI refuses to produce.
 */
export class UsageError extends OpenKaError {}

/**
 * An input the library refuses before doing anything with it: a blank option, an
 * unknown enum value, an out-of-range number. A `UsageError` — so it exits 2 like
 * one, and every existing `instanceof UsageError` check keeps catching it — whose
 * message reads `Invalid <name>: <reason>`. `reason` is the bare sentence, which is
 * what a CLI value parser prints after commander's own prefix.
 */
export class OpenKaValidationError extends UsageError {
  readonly reason: string;

  constructor(message: string, options: { reason: string; cause?: unknown }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.reason = options.reason;
  }
}

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

export { assertValid, isBlank, intRangeProblem, nonBlankProblem, BLANK_REASON, type Problem } from "./validate.js";
