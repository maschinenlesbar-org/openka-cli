#!/usr/bin/env node
// The `ka` bin shim: argv in, exit code out. All the logic lives in run().

import { run } from "./run.js";

process.exitCode = await run(process.argv.slice(2));
