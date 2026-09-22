// Parse argv, run the command, return an exit code. Kept apart from the bin shim
// so tests can drive the whole CLI in-process with injected deps and assert on the
// captured output and the exit code.

import { CommanderError, type Command } from "commander";
import { AbstainError, OpenKaApiError, OpenKaError, StoreError, UsageError } from "../core/errors.js";
import { buildProgram, defaultDeps } from "./program.js";
import { sanitizeForTerminal } from "./text.js";
import type { CliDeps } from "./io.js";

/**
 * Exit codes, documented so they are scriptable:
 *   0  success (including `--help` and `--version`)
 *   1  an error — an upstream failure, a corpus problem, a failed verification
 *   2  a usage error (commander's parse failures are remapped to this)
 *   3  the corpus is missing or unreadable
 *   4  the requested record or resource does not exist upstream (HTTP 404)
 *
 * Every message printed here goes through `sanitizeForTerminal`: an error text
 * routinely quotes upstream data — a URL, a Content-Type, a record id — and an
 * error path is no less of a terminal than the success path.
 */
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;
export const EXIT_STORE = 3;
export const EXIT_NOT_FOUND = 4;

/**
 * Apply exitOverride and output redirection to every command in the tree.
 * Commander does not propagate these to subcommands, so a parse error on a
 * subcommand would otherwise call process.exit() and bypass the handling below.
 */
function configureTree(command: Command, deps: CliDeps): void {
  command.exitOverride();
  command.configureOutput({
    writeOut: (str) => deps.io.out(str.replace(/\n$/, "")),
    writeErr: (str) => deps.io.err(str.replace(/\n$/, "")),
  });
  for (const child of command.commands) configureTree(child, deps);
}

export async function run(argv: string[], deps: CliDeps = defaultDeps): Promise<number> {
  const program = buildProgram(deps);
  configureTree(program, deps);

  try {
    await program.parseAsync(argv, { from: "user" });
    return EXIT_OK;
  } catch (err) {
    if (err instanceof CommanderError) {
      // Help and version requests exit 0; every genuine parse error is a usage error.
      if (err.exitCode === 0) return EXIT_OK;
      return EXIT_USAGE;
    }
    if (err instanceof OpenKaApiError) {
      deps.io.err(`Error: ${sanitizeForTerminal(err.message)}`);
      return err.status === 404 ? EXIT_NOT_FOUND : EXIT_ERROR;
    }
    if (err instanceof UsageError) {
      deps.io.err(`Error: ${sanitizeForTerminal(err.message)}`);
      return EXIT_USAGE;
    }
    if (err instanceof StoreError) {
      deps.io.err(`Error: ${sanitizeForTerminal(err.message)}`);
      return EXIT_STORE;
    }
    if (err instanceof AbstainError || err instanceof OpenKaError) {
      deps.io.err(`Error: ${sanitizeForTerminal(err.message)}`);
      return EXIT_ERROR;
    }
    deps.io.err(`Unexpected error: ${sanitizeForTerminal(err instanceof Error ? err.message : String(err))}`);
    return EXIT_ERROR;
  }
}
