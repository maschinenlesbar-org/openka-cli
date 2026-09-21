// argv in, exit code out — the factory's equivalent of `src/cli/run.ts`.

import { CommanderError } from "commander";
import { OpenKaError, StoreError } from "../../core/errors.js";
import { EXIT_ERROR, EXIT_OK, EXIT_STORE, EXIT_USAGE } from "../../cli/run.js";
import { defaultDeps, type CliDeps } from "../../cli/io.js";
import { buildFactoryProgram } from "./program.js";
import type { Command } from "commander";

function configureTree(command: Command, deps: CliDeps): void {
  command.exitOverride();
  command.configureOutput({
    writeOut: (str) => deps.io.out(str.replace(/\n$/, "")),
    writeErr: (str) => deps.io.err(str.replace(/\n$/, "")),
  });
  for (const child of command.commands) configureTree(child, deps);
}

export async function runFactory(argv: string[], deps: CliDeps = defaultDeps): Promise<number> {
  const program = buildFactoryProgram(deps);
  configureTree(program, deps);
  try {
    await program.parseAsync(argv, { from: "user" });
    return EXIT_OK;
  } catch (err) {
    if (err instanceof CommanderError) return err.exitCode === 0 ? EXIT_OK : EXIT_USAGE;
    if (err instanceof StoreError) {
      deps.io.err(`Error: ${err.message}`);
      return EXIT_STORE;
    }
    if (err instanceof OpenKaError) {
      deps.io.err(`Error: ${err.message}`);
      return EXIT_ERROR;
    }
    deps.io.err(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT_ERROR;
  }
}
