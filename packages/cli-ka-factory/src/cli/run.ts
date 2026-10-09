// argv in, exit code out — the factory's equivalent of `cli-ka`'s `run.ts`, and its
// log: the same records (`cli-ka`'s `log.ts`), under the program name `ka-factory`.

import { CommanderError } from "commander";
import { OpenKaError, OpenKaValidationError, StoreError } from "@maschinenlesbar.org/openka-lib-errors";
import {
  EXIT_ERROR,
  EXIT_OK,
  EXIT_STORE,
  EXIT_USAGE,
  configureTree,
  defaultDeps,
  errorArea,
  followParsedLogFormat,
  logOf,
  trackCommandArea,
  withLogger,
  type CliDeps,
} from "@maschinenlesbar.org/openka-cli-ka";
import { buildFactoryProgram } from "./program.js";

/** The program's name in every topic of the factory's log: `ka-factory.<area>`. */
export const FACTORY_LOG_PROGRAM = "ka-factory";

export async function runFactory(argv: string[], deps: CliDeps = defaultDeps): Promise<number> {
  deps = withLogger(deps, argv, FACTORY_LOG_PROGRAM);
  const program = buildFactoryProgram(deps);
  followParsedLogFormat(program, deps, argv);
  configureTree(program, deps);
  const commandArea = trackCommandArea(program);
  try {
    await program.parseAsync(argv, { from: "user" });
    return EXIT_OK;
  } catch (err) {
    if (err instanceof CommanderError) return err.exitCode === 0 ? EXIT_OK : EXIT_USAGE;
    const log = logOf(deps);
    if (!(err instanceof OpenKaError)) {
      log.error("cli", `Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
      return EXIT_ERROR;
    }
    log.error(errorArea(err, commandArea()), err.message);
    // An input the library refused is a usage error wherever it was caught: at
    // parse time by commander, or here, when a library function rejects it.
    if (err instanceof OpenKaValidationError) return EXIT_USAGE;
    if (err instanceof StoreError) return EXIT_STORE;
    return EXIT_ERROR;
  }
}
