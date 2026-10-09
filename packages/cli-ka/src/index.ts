#!/usr/bin/env node
// The `ka` bin shim: argv in, exit code out. All the logic lives in run().

import { handleOutputErrors } from "./io.js";
import { installWarningLog } from "./log.js";
import { processLogger, run } from "./run.js";

// What happens outside run() is logged too, in the format argv asks for: Node's own
// process warnings, and an output error. A closed pipe (`ka export | head`) is ordinary
// use, not a crash.
const argv = process.argv.slice(2);
const log = processLogger(argv);
installWarningLog(process, log);
handleOutputErrors(process, undefined, log);
process.exitCode = await run(argv);
