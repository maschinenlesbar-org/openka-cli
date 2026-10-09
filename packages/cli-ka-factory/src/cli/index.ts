#!/usr/bin/env node
// The `ka-factory` bin shim.

import { handleOutputErrors, installWarningLog, processLogger } from "@maschinenlesbar.org/openka-cli-ka";
import { FACTORY_LOG_PROGRAM, runFactory } from "./run.js";

// A closed pipe (`ka-factory goldens list | head`) is ordinary use, not a crash; any
// other output error, and Node's own process warnings, are records of the factory's log.
const argv = process.argv.slice(2);
const log = processLogger(argv, FACTORY_LOG_PROGRAM);
installWarningLog(process, log);
handleOutputErrors(process, undefined, log);
process.exitCode = await runFactory(argv);
