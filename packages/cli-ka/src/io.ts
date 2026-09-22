// I/O seam for the CLI. Everything the CLI reads from the world or writes to it
// goes through a deps object, so the whole program can be driven in-process by a
// test with a temporary corpus, a mocked transport and captured output — no
// subprocess, no network, no clock.

import { writeFileSync } from "node:fs";
import { FileStore } from "@maschinenlesbar.org/openka-lib-store";
import { FetchEngine, type EngineOptions } from "@maschinenlesbar.org/openka-lib-http";
import type { Store } from "@maschinenlesbar.org/openka-lib-store";

export interface CliIO {
  out(text: string): void;
  err(text: string): void;
  writeFile(path: string, data: Buffer): void;
}

export interface CliDeps {
  io: CliIO;
  /** Open (or create) the corpus at `root`. */
  createStore(root: string): Store;
  createEngine(options: EngineOptions): FetchEngine;
  env: NodeJS.ProcessEnv;
  /** The clock. Injected so `retrieved_at` and feed timestamps are testable. */
  now(): Date;
}

export const defaultIO: CliIO = {
  out: (text) => process.stdout.write(text + "\n"),
  err: (text) => process.stderr.write(text + "\n"),
  writeFile: (path, data) => writeFileSync(path, data),
};

export const defaultDeps: CliDeps = {
  io: defaultIO,
  createStore: (root) => new FileStore(root),
  createEngine: (options) => new FetchEngine(options),
  env: process.env,
  now: () => new Date(),
};
