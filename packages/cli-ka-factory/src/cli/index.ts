#!/usr/bin/env node
// The `ka-factory` bin shim.

import { runFactory } from "./run.js";

process.exitCode = await runFactory(process.argv.slice(2));
