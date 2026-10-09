// Parse argv, run the command, return an exit code. Kept apart from the bin shim
// so tests can drive the whole CLI in-process with injected deps and assert on the
// captured output and the exit code.

import { CommanderError, type Command } from "commander";
import { NetworkError, OpenKaApiError, OpenKaError, ParseError, StoreError, UsageError } from "@maschinenlesbar.org/openka-lib-errors";
import { buildProgram, defaultDeps } from "./program.js";
import { InterruptedRunError, logOf, type CliDeps } from "./io.js";
import { DEFAULT_LOG_FORMAT, LOG_PROGRAM, createLogger, logFormatFromArgv, type LogFormat, type Logger } from "./log.js";
import { VersionOnlyError } from "@maschinenlesbar.org/openka-lib-verify";

/**
 * Exit codes, documented so they are scriptable:
 *   0  success (including `--help` and `--version`)
 *   1  an error — an upstream failure, a missing record, a failed verification
 *   2  a usage error (commander's parse failures are remapped to this)
 *   3  a corpus problem: missing or unreadable, held by another run, on a refused
 *      filesystem or short of space (`ka sync`), or a problem `ka doctor` found
 *   4  the requested record or resource does not exist upstream (HTTP 404)
 *   5  `ka verify`: every content reproduces, but some records carry another
 *      build's extractor version (`ka reextract` restamps them)
 *   130 / 143  `ka sync` stopped early on Ctrl-C / SIGTERM, after saving its catalog
 *
 * Every message is logged (`log.ts`), and the logger sanitises it: an error text
 * routinely quotes upstream data — a URL, a Content-Type, a record id — and an
 * error path is no less of a terminal than the success path.
 */
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;
export const EXIT_STORE = 3;
export const EXIT_NOT_FOUND = 4;
export const EXIT_VERSION_ONLY = 5;

/**
 * Apply exitOverride and output redirection to every command in the tree.
 * Commander does not propagate these to subcommands, so a parse error on a
 * subcommand would otherwise call process.exit() and bypass the handling below.
 * commander's own messages on stderr are log records of `<program>.cli`, one per
 * line (`writeCommanderErr`). Shared with `ka-factory`.
 */
export function configureTree(command: Command, deps: CliDeps, state: { errorLogged: boolean } = { errorLogged: false }): void {
  command.exitOverride();
  command.configureOutput({
    writeOut: (str) => deps.io.out(str.replace(/\n$/, "")),
    // Commander's own errors echo the rejected value, which is the user's input
    // and may carry terminal controls; the logger sanitises and escapes every record.
    writeErr: (str) => writeCommanderErr(command, deps, state, str),
  });
  for (const child of command.commands) configureTree(child, deps, state);
}

/** `ka sources`: the command's name with its parents'. */
function commandPath(command: Command): string {
  const names: string[] = [];
  for (let c: Command | null = command; c !== null; c = c.parent) names.unshift(c.name());
  return names.join(" ");
}

/**
 * commander's stderr output as log records, one per line. Its `error: …` is an ERROR of
 * `cli`, with a following `(Did you mean …?)` line appended to that same record; the
 * help it shows after an error is one INFO record per non-blank line. A command group
 * run without its subcommand (bare `ka`, `ka sources`) makes commander show the help as
 * an error (exit 1, so 2 here) with no `error:` line: an ERROR record "missing command:
 * `ka sources <subcommand>`" comes first, so every failed run has one.
 */
function writeCommanderErr(command: Command, deps: CliDeps, state: { errorLogged: boolean }, str: string): void {
  const log = logOf(deps);
  // commander writes the blank line before the help it shows after an error on its own;
  // an empty record says nothing.
  const text = str.replace(/^\n+|\n+$/g, "");
  if (text.trim() === "") return;
  if (text.startsWith("error: ")) {
    state.errorLogged = true;
    log.error("cli", text.slice("error: ".length).replace(/\n(\(Did you mean .*\?\))$/, " $1"));
    return;
  }
  if (!state.errorLogged) {
    state.errorLogged = true;
    log.error("cli", `missing command: \`${commandPath(command)} <subcommand>\``);
  }
  for (const line of text.split("\n")) if (line.trim() !== "") log.info("cli", line.trimEnd());
}

/**
 * The logger for what happens outside `run()` — Node's process warnings, a stdout write
 * error — in the format argv asks for, on the real stderr. The bin shims build it.
 */
export function processLogger(argv: readonly string[], program: string = LOG_PROGRAM): Logger {
  return createLogger({ format: logFormatFromArgv(argv), write: (line) => process.stderr.write(line + "\n"), program });
}

/**
 * `deps` with the run's logger: the `--log-format` in `argv`, read before commander
 * parses it, so that commander's own usage errors are records in that format too.
 */
export function withLogger(deps: CliDeps, argv: readonly string[], program: string = LOG_PROGRAM): CliDeps {
  return { ...deps, log: createLogger({ format: logFormatFromArgv(argv), write: (line) => deps.io.err(line), now: () => deps.now(), program }) };
}

/**
 * The names (long and short) of the program's own options that require a value
 * (`--user-agent`). Only the program's: commander takes them out of argv wherever they
 * stand, before a subcommand sees the rest.
 */
function valueOptionsOf(program: Command): Set<string> {
  const names = new Set<string>();
  for (const option of program.options) {
    if (!option.required) continue;
    if (option.long !== undefined) names.add(option.long);
    if (option.short !== undefined) names.add(option.short);
  }
  return names;
}

/**
 * One source for the log format: for the records of a parse error, the scan of argv,
 * knowing which of the program's options take a value; once commander has parsed argv,
 * its value (a `preAction` hook, which runs before every other one, so before an action
 * reads `log.format`). An option's value can look like `--log-format`. Shared with
 * `ka-factory`.
 */
export function followParsedLogFormat(program: Command, deps: CliDeps, argv: readonly string[]): void {
  const log = deps.log;
  if (log === undefined) return;
  log.format = logFormatFromArgv(argv, valueOptionsOf(program));
  program.hook("preAction", (_program, actionCommand) => {
    const format = (actionCommand.optsWithGlobals() as { logFormat?: LogFormat }).logFormat;
    log.format = format ?? DEFAULT_LOG_FORMAT;
  });
}

/**
 * The area the command that runs logs under: its top-level name (`sync`, `sources`,
 * `goldens`), known once commander has picked it. Read by `errorArea`.
 */
export function trackCommandArea(program: Command): () => string | undefined {
  let area: string | undefined;
  program.hook("preAction", (_root, actionCommand) => {
    let command: Command = actionCommand;
    while (command.parent !== null && command.parent !== program) command = command.parent;
    area = command.name();
  });
  return () => area;
}

/**
 * Which area an error that ends the run is logged under: a usage error is the
 * command line's (`cli`), a corpus problem the store's, an upstream's error answer or a
 * dropped connection `http`, an answer that could not be read (bad JSON, wrong shape)
 * `api`; anything else belongs to the command that ran.
 */
export function errorArea(err: unknown, commandArea: string | undefined): string {
  if (err instanceof UsageError) return "cli";
  if (err instanceof StoreError) return "store";
  if (err instanceof OpenKaApiError || err instanceof NetworkError) return "http";
  if (err instanceof ParseError) return "api";
  return commandArea ?? "cli";
}

export async function run(argv: string[], deps: CliDeps = defaultDeps): Promise<number> {
  deps = withLogger(deps, argv);
  const program = buildProgram(deps);
  followParsedLogFormat(program, deps, argv);
  configureTree(program, deps);
  const commandArea = trackCommandArea(program);

  try {
    await program.parseAsync(argv, { from: "user" });
    return EXIT_OK;
  } catch (err) {
    if (err instanceof CommanderError) {
      // Help and version requests exit 0; every genuine parse error is a usage error.
      if (err.exitCode === 0) return EXIT_OK;
      return EXIT_USAGE;
    }
    const log = logOf(deps);
    if (!(err instanceof OpenKaError)) {
      log.error("cli", `Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
      return EXIT_ERROR;
    }
    log.error(errorArea(err, commandArea()), err.message);
    if (err instanceof OpenKaApiError) return err.status === 404 ? EXIT_NOT_FOUND : EXIT_ERROR;
    // Includes OpenKaValidationError: an input a library function refused is a
    // usage error, the same as one commander's value parser refused.
    if (err instanceof UsageError) return EXIT_USAGE;
    if (err instanceof StoreError) return EXIT_STORE;
    if (err instanceof VersionOnlyError) return EXIT_VERSION_ONLY;
    if (err instanceof InterruptedRunError) return err.exitCode;
    return EXIT_ERROR;
  }
}
