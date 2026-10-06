#!/usr/bin/env node
// The `ka` bin shim: argv in, exit code out. All the logic lives in run().

import { handleOutputErrors } from "./io.js";
import { run } from "./run.js";

// A closed pipe (`ka export | head`) is ordinary use, not a crash.
handleOutputErrors();
process.exitCode = await run(process.argv.slice(2));
