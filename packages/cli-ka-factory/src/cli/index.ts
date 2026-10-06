#!/usr/bin/env node
// The `ka-factory` bin shim.

import { handleOutputErrors } from "@maschinenlesbar.org/openka-cli-ka";
import { runFactory } from "./run.js";

// A closed pipe (`ka-factory goldens list | head`) is ordinary use, not a crash.
handleOutputErrors();
process.exitCode = await runFactory(process.argv.slice(2));
