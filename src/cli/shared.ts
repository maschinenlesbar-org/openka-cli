// Shared CLI helpers: option parsers, global-option resolution, and the few
// rendering paths every command group uses.
//
// Every option that takes a value gets a parser. A blank filter is a usage error
// rather than a silently-dropped constraint — a search that quietly ignores
// `--party ""` and returns everything is the kind of wrong answer this project
// exists to avoid.

import { Command, InvalidArgumentError, Option } from "commander";
import { ParliamentKeys } from "../core/models/parliaments.js";
import type { SearchFilters } from "../core/search/search.js";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { OpenKaError } from "../core/errors.js";
import { MAX_TIMEOUT_MS } from "../core/http/http.js";
import type { EngineOptions } from "../core/http/engine.js";
import { escapeControlChars } from "./text.js";
import type { CliDeps } from "./io.js";
import type { Store } from "../core/store/store.js";

/** Environment variable naming the corpus directory. */
export const CORPUS_ENV = "OPENKA_CORPUS";

/** Where a corpus lives when neither the flag nor the environment says. */
export function defaultCorpusRoot(env: NodeJS.ProcessEnv): string {
  const fromEnv = env[CORPUS_ENV]?.trim();
  if (fromEnv !== undefined && fromEnv !== "") return resolve(fromEnv);
  const xdg = env["XDG_DATA_HOME"]?.trim();
  if (xdg !== undefined && xdg !== "") return resolve(xdg, "openka");
  return resolve(homedir(), ".local", "share", "openka");
}

function parseDecimalInt(value: string): number | undefined {
  if (!/^-?\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/** commander value-parser: an integer constrained to [min, max]. */
export function parseBoundedInt(min: number, max?: number): (value: string) => number {
  return (value: string) => {
    const parsed = parseDecimalInt(value);
    if (parsed === undefined) throw new InvalidArgumentError("Expected an integer.");
    if (parsed < min) throw new InvalidArgumentError(`Must be >= ${min}.`);
    if (max !== undefined && parsed > max) throw new InvalidArgumentError(`Must be <= ${max}.`);
    return parsed;
  };
}

/** commander value-parser: a non-empty (after trimming) string. */
export function parseNonEmpty(value: string): string {
  if (value.trim() === "") throw new InvalidArgumentError("Expected a non-empty value.");
  return value;
}

/** commander value-parser: an ISO `YYYY-MM-DD` calendar date. */
export function parseIsoDate(value: string): string {
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) throw new InvalidArgumentError("Expected a date as YYYY-MM-DD.");
  const [year, month, day] = trimmed.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new InvalidArgumentError("Not a calendar date.");
  }
  return trimmed;
}

/** commander accumulator for repeatable string options; blanks are rejected. */
export function collect(value: string, previous: string[] = []): string[] {
  return previous.concat([parseNonEmpty(value)]);
}

/** commander accumulator for repeatable integer options. */
export function collectInt(min: number, max?: number): (value: string, previous?: number[]) => number[] {
  const parse = parseBoundedInt(min, max);
  return (value: string, previous: number[] = []) => previous.concat([parse(value)]);
}

export interface GlobalOptions {
  corpus?: string;
  timeout?: number;
  userAgent?: string;
  maxRetries?: number;
  maxResponseBytes?: number;
  minHostInterval?: number;
  maxRedirects?: number;
  compact?: boolean;
  quiet?: boolean;
}

/** Translate global CLI options into engine options. */
export function toEngineOptions(global: GlobalOptions): EngineOptions {
  const options: EngineOptions = {};
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
  /** The corpus, opened lazily so `--help` never creates a directory. */
  store(): Store;
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
): (...args: unknown[]) => Promise<void> {
  return async (...args: unknown[]) => {
    const command = args[args.length - 1] as Command;
    const positionals = args.slice(0, Math.max(0, args.length - 2)) as string[];
    const global = command.optsWithGlobals() as GlobalOptions;
    const root = global.corpus !== undefined ? resolve(global.corpus) : defaultCorpusRoot(deps.env);
    let store: Store | undefined;
    await fn(
      {
        deps,
        global,
        opts: command.opts(),
        corpusRoot: () => root,
        store: () => (store ??= deps.createStore(root)),
      },
      positionals,
    );
  };
}

/** Print a JSON value, pretty by default and compact with --compact. */
export function printJson(ctx: ActionContext, value: unknown): void {
  const text = ctx.global.compact ? JSON.stringify(value) : JSON.stringify(value, null, 2);
  ctx.deps.io.out(escapeControlChars(text));
}

/** Write text to a file, or print it when no path was given. */
export function emit(ctx: ActionContext, text: string, outPath: string | undefined): void {
  if (outPath === undefined) {
    ctx.deps.io.out(text.replace(/\n$/, ""));
    return;
  }
  const data = Buffer.from(text, "utf8");
  try {
    ctx.deps.io.writeFile(outPath, data);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new OpenKaError(`could not write ${outPath}: ${reason}`, { cause: err });
  }
  ctx.deps.io.err(`Wrote ${data.length} bytes to ${outPath}`);
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
    .option("--parliament <key>", `restrict to a parliament (repeatable; ${ParliamentKeys.length} known)`, collect)
    .option("--party <name>", "restrict to Anfragen asked by this party (repeatable)", collect)
    .option("--year <yyyy>", "restrict to a year (repeatable)", collectInt(1949, 2999))
    .option("--period <n>", "restrict to a legislative period (repeatable)", collectInt(1, 99))
    .option("--from <date>", "answered (or submitted) on or after this date", parseIsoDate)
    .option("--to <date>", "answered (or submitted) on or before this date", parseIsoDate);
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

/** An Option constrained to a fixed set of choices. */
export function choiceOption(flags: string, description: string, choices: readonly string[]): Option {
  return new Option(flags, description).choices([...choices]);
}

/** Add the shared corpus/network options to the root program. */
export function addGlobalOptions(program: Command): Command {
  return program
    .option("--corpus <dir>", `corpus directory (default: $${CORPUS_ENV} or ~/.local/share/openka)`, parseNonEmpty)
    .option("--timeout <ms>", "per-request timeout in milliseconds", parseBoundedInt(0, MAX_TIMEOUT_MS))
    .option("--user-agent <ua>", "User-Agent sent to upstreams", parseNonEmpty)
    .option("--max-retries <n>", "retries for transient 429/503 responses", parseBoundedInt(0, 10))
    .option("--max-response-bytes <n>", "hard cap on a single response body", parseBoundedInt(1024))
    .option("--min-host-interval <ms>", "minimum delay between requests to one host", parseBoundedInt(0, 60_000))
    .option("--max-redirects <n>", "redirects to follow (0 = surface a 3xx as an error)", parseBoundedInt(0, 10))
    .option("--compact", "compact JSON output")
    .option("--quiet", "suppress progress output on stderr");
}
