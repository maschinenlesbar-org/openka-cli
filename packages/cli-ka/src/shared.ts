// Shared CLI helpers: option parsers, global-option resolution, and the few
// rendering paths every command group uses.
//
// Every option that takes a value gets a parser. A blank filter is a usage error
// rather than a silently-dropped constraint — a search that quietly ignores
// `--party ""` and returns everything is the kind of wrong answer this project
// exists to avoid.

import { Command, InvalidArgumentError, Option } from "commander";
import { ParliamentKeys, isoDateProblem, normalizeIsoDate, normalizeParliamentKey } from "@maschinenlesbar.org/openka-lib-models";
import {
  PERIOD_RANGE,
  YEAR_RANGE,
  intRangeProblem,
  searchParliamentProblem,
  type SearchFilters,
} from "@maschinenlesbar.org/openka-lib-search";
import { statSync } from "node:fs";
import { MissingCorpusError, OpenKaError, apiKeyProblem, StoreError, UsageError, nonBlankProblem, type Problem } from "@maschinenlesbar.org/openka-lib-errors";
import {
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_MIN_HOST_INTERVAL_MS,
  MAX_HOST_INTERVAL_MS,
  MAX_REDIRECTS,
  MAX_RETRIES,
  MAX_TIMEOUT_MS,
  MIN_RESPONSE_BYTES,
  userAgentProblem,
} from "@maschinenlesbar.org/openka-lib-http";
import type { EngineOptions, RetryEvent } from "@maschinenlesbar.org/openka-lib-http";
import { escapeControlChars, sanitizeForTerminal } from "./text.js";
import { describeRequestFloor, floorKeptNote } from "@maschinenlesbar.org/openka-lib-source";
import { CredentialStore } from "@maschinenlesbar.org/openka-lib-store";
import { logOf, type CliDeps } from "./io.js";
import { DEFAULT_LOG_FORMAT, logFormatProblem } from "./log.js";
import {
  BLOBS_ENV,
  CORPUS_DEFAULT_TEXT,
  DEFAULT_MIN_FREE_BYTES,
  FileStore,
  REFUSED_FILESYSTEMS,
  byteSizeProblem,
  formatBytes,
  parseByteSize,
  recordIdProblem,
  resolveBlobRoot,
  resolveCorpusRoot,
  systemVolumes,
  type RefusedFilesystem,
  type Store,
  type VolumeCheckOptions,
} from "@maschinenlesbar.org/openka-lib-store";

/** Environment variable naming the corpus directory (lib-store's). */
export { CORPUS_ENV } from "@maschinenlesbar.org/openka-lib-store";

function parseDecimalInt(value: string): number | undefined {
  if (!/^-?\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/**
 * commander value-parser: an integer constrained to [min, max]. Reading the
 * decimal is the CLI's part; the range is the library's `intRangeProblem`.
 */
export function parseBoundedInt(min: number, max?: number): (value: string) => number {
  const problem = intRangeProblem(min, max);
  return (value: string) => {
    const parsed = parseDecimalInt(value);
    if (parsed === undefined) throw new InvalidArgumentError("Expected an integer.");
    const reason = problem(parsed);
    if (reason !== undefined) throw new InvalidArgumentError(reason);
    return parsed;
  };
}

/**
 * commander value-parser built from a library rule: the library's own reason,
 * verbatim, as a usage error. The rule is written once, in the library.
 */
export function problemParser(problem: Problem<string>): (value: string) => string {
  return (value: string) => {
    const reason = problem(value);
    if (reason !== undefined) throw new InvalidArgumentError(reason);
    return value;
  };
}

/**
 * commander value-parser: a non-empty (after trimming) string. The rule is the
 * library's `nonBlankProblem`, so "blank" means the same on both sides.
 */
export const parseNonEmpty: (value: string) => string = problemParser(nonBlankProblem);

/**
 * commander value-parser for `--api-key`: non-blank, and a key a header can carry
 * (`apiKeyProblem`). A key that fails is a `UsageError` of its own, not commander's
 * `InvalidArgumentError`, because commander quotes the argument in its message and the
 * key (a real one with a stray newline from a paste) must not reach the log.
 */
export function parseApiKey(value: string): string {
  const reason = nonBlankProblem(value) ?? apiKeyProblem(value);
  if (reason !== undefined) throw new UsageError(`--api-key: ${reason}`);
  return value;
}

/**
 * commander value-parser: a record id — the library's `recordIdProblem`. A
 * malformed one ("BERLIN-19-10006", "../x") is a usage mistake on both sides; it
 * used to surface from the store as exit 3, "the corpus is missing or unreadable",
 * which says nothing about the id.
 */
export const parseRecordId: (value: string) => string = problemParser(recordIdProblem);

/** commander value-parser: an ISO `YYYY-MM-DD` calendar date — the library's rule. */
export function parseIsoDate(value: string): string {
  const reason = isoDateProblem(value);
  if (reason !== undefined) throw new InvalidArgumentError(reason);
  return normalizeIsoDate(value);
}

/** commander accumulator for repeatable string options; blanks are rejected. */
export function collect(value: string, previous: string[] = []): string[] {
  return previous.concat([parseNonEmpty(value)]);
}

/**
 * commander value-parser: a parliament key, folded to lower case. Any string used
 * to be accepted, so `--parliament narnia` or `--parliament Berlin` filtered
 * everything away and answered "No matches." with exit 0 — a filter that cannot
 * match is a usage error.
 */
export function parseParliament(value: string): string {
  const reason = searchParliamentProblem(value);
  if (reason !== undefined) throw new InvalidArgumentError(reason);
  return normalizeParliamentKey(value);
}

/** commander accumulator for a repeatable `--parliament`. */
export function collectParliament(value: string, previous: string[] = []): string[] {
  return previous.concat([parseParliament(value)]);
}

/** commander accumulator for repeatable integer options. */
export function collectInt(min: number, max?: number): (value: string, previous?: number[]) => number[] {
  const parse = parseBoundedInt(min, max);
  return (value: string, previous: number[] = []) => previous.concat([parse(value)]);
}

export interface GlobalOptions {
  corpus?: string;
  blobs?: string;
  timeout?: number;
  userAgent?: string;
  maxRetries?: number;
  maxResponseBytes?: number;
  minHostInterval?: number;
  maxRedirects?: number;
  compact?: boolean;
  quiet?: boolean;
  logFormat?: string;
}

/** `HTTP 503 from host: retry 1 of 3 in 2 s` (host only; whole seconds, ms under 1 s). */
export function retryMessage(event: RetryEvent): string {
  let host: string;
  try {
    host = new URL(event.url).host;
  } catch {
    host = "the server";
  }
  const why = event.status === undefined ? "connection reset" : `HTTP ${event.status}`;
  const wait = event.delayMs < 1000 ? `${event.delayMs} ms` : `${Math.round(event.delayMs / 1000)} s`;
  return `${why} from ${host}: retry ${event.retry} of ${event.maxRetries} in ${wait}`;
}

/** Translate global CLI options into engine options; each retry is a WARN record of `http`. */
export function toEngineOptions(global: GlobalOptions, deps: Pick<CliDeps, "io" | "now" | "log">): EngineOptions {
  const options: EngineOptions = { onRetry: (event) => logOf(deps).warn("http", retryMessage(event)) };
  if (global.timeout !== undefined) options.timeoutMs = global.timeout;
  if (global.userAgent !== undefined) options.userAgent = global.userAgent;
  if (global.maxRetries !== undefined) options.maxRetries = global.maxRetries;
  if (global.maxResponseBytes !== undefined) options.maxResponseBytes = global.maxResponseBytes;
  if (global.minHostInterval !== undefined) options.minHostIntervalMs = global.minHostInterval;
  if (global.maxRedirects !== undefined) options.maxRedirects = global.maxRedirects;
  return options;
}

export interface ActionContext {
  deps: CliDeps;
  global: GlobalOptions;
  opts: Record<string, unknown>;
  /** Every argument commander saw for the command, declared or not. */
  args: readonly string[];
  /**
   * The area the command's log records go under: its top-level name (`sync`,
   * `export`, `sources`), so `ka.export` says who spoke. Cross-cutting records keep
   * their own: `cli`, `http`, `store`.
   */
  area: string;
  /** The corpus, opened lazily so `--help` never creates a directory. */
  store(): Store;
  /**
   * The corpus, for a command that only reads one: a directory that is not there
   * is a StoreError (exit 3). A mistyped `--corpus` used to look like an empty
   * result — "No matches.", "0 record(s)" — and exit 0.
   */
  existingStore(): Store;
  corpusRoot(): string;
}

/**
 * Wrap a command action with global-option resolution. Commander calls actions as
 * (arg1, …, argN, options, command); the trailing two are sliced off to recover
 * the positionals.
 */
export function action(
  deps: CliDeps,
  fn: (ctx: ActionContext, positionals: string[]) => Promise<void>,
  /** `noteIgnored: false` for a command that reports the platform files itself (`ka doctor`). */
  options: { noteIgnored?: boolean } = {},
): (...args: unknown[]) => Promise<void> {
  return async (...args: unknown[]) => {
    const command = args[args.length - 1] as Command;
    const positionals = args.slice(0, Math.max(0, args.length - 2)) as string[];
    const global = command.optsWithGlobals() as GlobalOptions;
    // flag > OPENKA_CORPUS > XDG_DATA_HOME > home, each path as given: the
    // library's resolution, so the flag and the env var name the same directory.
    const root = resolveCorpusRoot({ ...(global.corpus === undefined ? {} : { root: global.corpus }), env: deps.env });
    const blobs = resolveBlobRoot({ ...(global.blobs === undefined ? {} : { blobs: global.blobs }), env: deps.env });
    const storeOptions = blobs === undefined ? {} : { blobs };
    let store: Store | undefined;
    const ctx: ActionContext = {
      deps,
      global,
      opts: command.opts(),
      args: command.args,
      area: topLevelName(command),
      corpusRoot: () => root,
      store: () => (store ??= deps.createStore(root, storeOptions)),
      existingStore: () => {
        if (store !== undefined) return store;
        try {
          return (store = deps.openStore(root, storeOptions));
        } catch (err) {
          // Whether a corpus is there is the library's call; where the path
          // came from — and so what to check — is the CLI's to say.
          if (err instanceof MissingCorpusError) {
            throw new StoreError(`${err.message} Check --corpus / OPENKA_CORPUS, or run \`ka sync\` first.`, { cause: err });
          }
          throw err;
        }
      },
    };
    try {
      await fn(ctx, positionals);
    } finally {
      // `ctx.deps`, not `deps`: a command may have given the run a logger of its own
      // (`ka sync --log-file`), and the note belongs in it too.
      if (store instanceof FileStore && options.noteIgnored !== false) noteIgnoredFiles(ctx.deps, store);
    }
  };
}

/** The name of the top-level command `command` is, or is under: `sources` for `ka sources count`. */
function topLevelName(command: Command): string {
  let top = command;
  while (top.parent?.parent !== null && top.parent?.parent !== undefined) top = top.parent;
  return top.name();
}

/**
 * Say once, after the command, that the corpus listings skipped platform files
 * (`._*`, `.DS_Store`) — what macOS leaves on a FAT32 or exFAT drive. Skipped
 * without a word, a user would never learn why `dot_clean` is worth running; a
 * hard stop on the first one, which is what this replaced, made the corpus
 * unusable.
 */
function noteIgnoredFiles(deps: CliDeps, store: FileStore): void {
  const ignored = store.ignoredFiles();
  if (ignored.length === 0) return;
  logOf(deps).info(
    "store",
    `ignored ${ignored.length} macOS AppleDouble/.DS_Store file(s) in the corpus; ` +
      `\`ka doctor --fix\` or \`dot_clean ${sanitizeForTerminal(store.root)}\` removes them.`,
  );
}

/**
 * Where a source's credential comes from, in this order: `--api-key`, the source's
 * environment variable (`DIP_API_KEY`), then the credentials file (`ka config set
 * bund.api-key`). The file is read only when the first two have nothing, so a
 * command that needs no key never trips over a broken one.
 */
export function apiKeyLookup(ctx: ActionContext): (source: { key: string; apiKeyEnv?: string }) => string | undefined {
  const flag = ctx.opts["apiKey"] as string | undefined;
  let store: CredentialStore | undefined;
  return (source) => {
    if (source.apiKeyEnv === undefined) return undefined;
    if (flag !== undefined) return flag;
    const fromEnv = ctx.deps.env[source.apiKeyEnv];
    if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv;
    store ??= CredentialStore.fromEnv(ctx.deps.env);
    return store.get(`${source.key}.api-key`);
  };
}

/**
 * Say, once per source and before any request, how fast a source with a floor of its
 * own will go: why it is slow (`describeRequestFloor`), or that a lower
 * `--min-host-interval` was kept out (`floorKeptNote`). A sync of Sachsen-Anhalt ran
 * at five Anfragen a minute, and nothing said why (issue #24). `--quiet` keeps the
 * first quiet, never the second: an option that did not take effect is always said.
 */
export function noteRequestFloors(
  ctx: ActionContext,
  sources: readonly { key: string; minHostIntervalMs?: number; minHostIntervalReason?: string }[],
): void {
  const requested = ctx.global.minHostInterval;
  const seen = new Set<string>();
  for (const source of sources) {
    if (seen.has(source.key) || source.minHostIntervalMs === undefined || source.minHostIntervalMs <= DEFAULT_MIN_HOST_INTERVAL_MS) continue;
    seen.add(source.key);
    const kept = requested === undefined ? undefined : floorKeptNote(source, requested);
    if (kept !== undefined) logOf(ctx.deps).info("http", `${kept}.`);
    else if (ctx.global.quiet !== true && (requested === undefined || requested < source.minHostIntervalMs)) {
      logOf(ctx.deps).info("http", `${source.key}: ${describeRequestFloor(source)}.`);
    }
  }
}

/** Print a JSON value, pretty by default and compact with --compact. */
export function printJson(ctx: ActionContext, value: unknown): void {
  const text = ctx.global.compact ? JSON.stringify(value) : JSON.stringify(value, null, 2);
  ctx.deps.io.out(escapeControlChars(text));
}

/** Write text to a file, or print it when no path was given. */
export function emit(ctx: ActionContext, text: string, outPath: string | undefined): void {
  if (outPath === undefined || outPath === "-") {
    ctx.deps.io.out(text.replace(/\n$/, ""));
    return;
  }
  const data = Buffer.from(text, "utf8");
  try {
    ctx.deps.io.writeFile(outPath, data, { overwrite: ctx.opts["force"] === true });
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (code === "EEXIST" || code === "EISDIR") {
      if (isDirectory(outPath)) throw new OpenKaError(`"${outPath}" is a directory; give a file path to --out.`);
      throw new UsageError(`Refusing to overwrite existing file ${outPath}; pass --force to replace it.`);
    }
    const reason = err instanceof Error ? err.message : String(err);
    throw new OpenKaError(`could not write ${outPath}: ${reason}`, { cause: err });
  }
  logOf(ctx.deps).info(ctx.area, `Wrote ${data.length} bytes to ${outPath}`);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The `-o, --out <file>` / `--force` pair every writing command shares. `-` is
 * stdout (it used to write a file named "-"), and an existing file is not replaced
 * without `--force` (it was, silently).
 */
export function addOutOptions(command: Command): Command {
  return command
    .option("-o, --out <file>", "write to this file instead of stdout (- = stdout; an existing file needs --force)", parseNonEmpty)
    .option("--force", "with --out, replace an existing file");
}

/** Where `emit` writes: undefined for stdout. `--force` without a file is refused. */
export function outTarget(ctx: ActionContext): string | undefined {
  const out = ctx.opts["out"] as string | undefined;
  if (ctx.opts["force"] === true && out === undefined) {
    throw new UsageError("--force needs --out (it only allows overwriting the --out file).");
  }
  return out === "-" ? undefined : out;
}

/**
 * The corpus-selection options every read command shares.
 *
 * One declaration, because two existed and had already drifted: the same
 * `--parliament` flag documented itself with a colon in one command and a
 * semicolon in the other, and `--party` had two different descriptions. A user
 * reading `ka search --help` and `ka export --help` saw two answers for one flag.
 * Commands add the options that are genuinely their own on top of this.
 */
export function addCorpusFilters(command: Command): Command {
  return command
    .option("--parliament <key>", `restrict to a parliament (repeatable; ${ParliamentKeys.length} known, see \`ka sources list\`)`, collectParliament)
    .option("--party <name>", "restrict to Anfragen asked by this party (repeatable)", collect)
    .option("--year <yyyy>", "restrict to the year the Anfrage was asked (repeatable)", collectInt(...YEAR_RANGE))
    .option("--period <n>", "restrict to a legislative period (repeatable)", collectInt(...PERIOD_RANGE))
    .option("--from <date>", "asked on or after this date (a record whose question date is unknown is left out)", parseIsoDate)
    .option("--to <date>", "asked on or before this date (a record whose question date is unknown is left out)", parseIsoDate);
}

/**
 * Say on stderr how many records a date filter left out only for lacking a
 * question date. They used to be placed at the answer's date instead, which put a
 * February question in May; leaving them out silently would hide them.
 */
export function noteUndated(ctx: ActionContext, undated: number): void {
  if (undated === 0) return;
  logOf(ctx.deps).info(
    ctx.area,
    `${undated} record(s) matched the other filters but have no question date, so --year/--from/--to ` +
      "left them out (combined papers are dated only by their answer; `ka review` lists the hole).",
  );
}

/**
 * Read those options back as typed filters. `reviewStatus` and `onlyAbstained`
 * come from options only `ka search` and `ka review` declare, so they are simply
 * absent elsewhere.
 */
export function corpusFiltersFrom(opts: Record<string, unknown>): SearchFilters {
  const filters: SearchFilters = {};
  if (opts["parliament"] !== undefined) filters.parliament = opts["parliament"] as string[];
  if (opts["party"] !== undefined) filters.party = opts["party"] as string[];
  if (opts["year"] !== undefined) filters.year = opts["year"] as number[];
  if (opts["period"] !== undefined) filters.period = opts["period"] as number[];
  if (opts["from"] !== undefined) filters.from = opts["from"] as string;
  if (opts["to"] !== undefined) filters.to = opts["to"] as string;
  if (opts["reviewStatus"] !== undefined) filters.reviewStatus = [opts["reviewStatus"] as string];
  if (opts["needsReview"] === true) filters.onlyAbstained = true;
  return filters;
}

/** commander value-parser: a size such as "500M" or "2G" — the library's `parseByteSize`. */
export function parseSize(value: string): number {
  const reason = byteSizeProblem(value);
  if (reason !== undefined) throw new InvalidArgumentError(reason);
  return parseByteSize(value) as number;
}

/** commander accumulator for a repeatable `--allow-fs`: each one of `REFUSED_FILESYSTEMS`. */
function collectAllowedFilesystem(value: string, previous: RefusedFilesystem[] = []): RefusedFilesystem[] {
  const kind = REFUSED_FILESYSTEMS.find((known) => known === value);
  if (kind === undefined) throw new InvalidArgumentError(`Allowed choices are ${REFUSED_FILESYSTEMS.join(", ")}.`);
  return previous.concat([kind]);
}

/**
 * The volume options `ka sync` and `ka doctor` share, so the doctor's verdict is the
 * one a sync with the same flags would reach.
 */
export function addVolumeOptions(command: Command): Command {
  return command
    .option(
      "--allow-fs <type>",
      `write to a corpus on this filesystem anyway (repeatable: ${REFUSED_FILESYSTEMS.join(", ")}); both are refused by default`,
      collectAllowedFilesystem,
    )
    .option(
      "--min-free <size>",
      `free space to keep on the corpus and blob volumes, e.g. 500M or 20G; 0 checks none (default: ${formatBytes(DEFAULT_MIN_FREE_BYTES)})`,
      parseSize,
    );
}

/** Those options, read back for the library, with the deps' volume probe. */
export function volumeOptionsFrom(ctx: ActionContext): VolumeCheckOptions & { minFreeBytes: number } {
  const allow = ctx.opts["allowFs"] as RefusedFilesystem[] | undefined;
  return {
    ...(allow === undefined ? {} : { allowFilesystems: allow }),
    minFreeBytes: (ctx.opts["minFree"] as number | undefined) ?? DEFAULT_MIN_FREE_BYTES,
    probe: ctx.deps.volumes ?? systemVolumes,
  };
}

/** An Option constrained to a fixed set of choices. */
export function choiceOption(flags: string, description: string, choices: readonly string[]): Option {
  return new Option(flags, description).choices([...choices]);
}

/** Add the shared corpus/network options to the root program. */
export function addGlobalOptions(program: Command): Command {
  return program
    .option("--corpus <dir>", `corpus directory (default: ${CORPUS_DEFAULT_TEXT})`, parseNonEmpty)
    .option(
      "--blobs <dir>",
      `keep the archived documents here instead of <corpus>/blobs — an existing directory, e.g. on an external drive (default: $${BLOBS_ENV})`,
      parseNonEmpty,
    )
    .option("--timeout <ms>", "timeout per request attempt in milliseconds (a timed-out request is retried once)", parseBoundedInt(0, MAX_TIMEOUT_MS))
    // The bounds and the User-Agent rule are FetchEngine's (assertEngineOptions);
    // these parsers only read argv into numbers and strings.
    .option("--user-agent <ua>", "User-Agent sent to upstreams", problemParser(userAgentProblem))
    .option("--max-retries <n>", "retries for a transient 429/503 or a dropped connection (never an over-size response)", parseBoundedInt(0, MAX_RETRIES))
    .option(
      "--max-response-bytes <n>",
      `hard cap on a single response body (default: ${DEFAULT_MAX_RESPONSE_BYTES}, 128 MiB); a document over it is left out of its record, with a warning`,
      parseBoundedInt(MIN_RESPONSE_BYTES),
    )
    .option(
      "--min-host-interval <ms>",
      `minimum delay between requests to one host (default: ${DEFAULT_MIN_HOST_INTERVAL_MS}); a source's own floor ` +
        "(ka sources show <key>) is never lowered by it",
      parseBoundedInt(0, MAX_HOST_INTERVAL_MS),
    )
    .option("--max-redirects <n>", "redirects to follow (0 = surface a 3xx as an error)", parseBoundedInt(0, MAX_REDIRECTS))
    .option("--compact", "compact JSON output")
    .option("--quiet", "suppress progress output on stderr")
    .option(
      "--log-format <format>",
      "how errors, warnings, notes and progress are written to stderr: text (log4j style: time, level, [topic], message) or " +
        `jsonl (one JSON object per line: ts, level, topic, msg; \`ka sync\` adds its event fields); default ${DEFAULT_LOG_FORMAT}`,
      problemParser(logFormatProblem),
    );
}
