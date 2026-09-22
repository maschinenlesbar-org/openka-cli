#!/usr/bin/env node
// The published `ka` bin. The implementation lives in the cli-ka package; this
// shim exists so the tarball has one stable entry point whatever the workspace
// layout underneath it is.
import "@maschinenlesbar.org/openka-cli-ka/bin";
