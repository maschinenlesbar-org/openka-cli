#!/usr/bin/env node
// The `ka-factory` bin shim.

import { createLogger, handleOutputErrors, logFormatFromArgv } from "@maschinenlesbar.org/openka-cli-ka";
import { FACTORY_LOG_PROGRAM, runFactory } from "./run.js";

// A closed pipe (`ka-factory goldens list | head`) is ordinary use, not a crash; any
// other output error is a record of the factory's log.
handleOutputErrors(
  process,
  undefined,
  createLogger({ format: logFormatFromArgv(process.argv.slice(2)), write: (line) => process.stderr.write(line + "\n"), program: FACTORY_LOG_PROGRAM }),
);
process.exitCode = await runFactory(process.argv.slice(2));
