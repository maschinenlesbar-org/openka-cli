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
  /**
   * Write a file. Without `overwrite` the file must not exist yet: an exclusive
   * create, which also never follows a symlink at the path.
   */
  writeFile(path: string, data: Buffer, options?: { overwrite?: boolean }): void;
}

export interface CliDeps {
  io: CliIO;
  /** Open (or create) the corpus at `root`. */
  createStore(root: string): Store;
  /** Open the existing corpus at `root` for reading; a missing one is an error. */
  openStore(root: string): Store;
  createEngine(options: EngineOptions): FetchEngine;
  env: NodeJS.ProcessEnv;
  /** The clock. Injected so `retrieved_at` and feed timestamps are testable. */
  now(): Date;
}

/** The two process streams, as far as `handleOutputErrors` needs them. */
export interface OutputStreams {
  stdout: Pick<NodeJS.WriteStream, "on">;
  stderr: Pick<NodeJS.WriteStream, "on">;
}

/**
 * Handle write errors on stdout and stderr, which Node otherwise reports as an
 * unhandled 'error' event: a 1.7 KB stack trace and exit 1.
 *
 * A reader that stops early — `ka export | head`, a pager closed after one screen —
 * closes the pipe while `ka` is still writing, and the next write fails with
 * EPIPE. That is ordinary use, so the process exits 0 at once, quietly. Any other
 * stdout error prints one `Output error: <message>` line and exits 1. On stderr an
 * EPIPE is ignored, so a failed run keeps its own exit code (2 for a usage error,
 * 3 for a corpus problem) when stderr's reader is gone; any other stderr error
 * exits 1 silently, since there is nowhere left to report it. Both bins install
 * this once, before `run()`.
 */
export function handleOutputErrors(
  streams: OutputStreams = process,
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  streams.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") return exit(0);
    process.stderr.write(`Output error: ${err.message}\n`);
    exit(1);
  });
  streams.stderr.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code !== "EPIPE") exit(1);
  });
}

export const defaultIO: CliIO = {
  out: (text) => process.stdout.write(text + "\n"),
  err: (text) => process.stderr.write(text + "\n"),
  writeFile: (path, data, options) => writeFileSync(path, data, { flag: options?.overwrite === true ? "w" : "wx" }),
};

export const defaultDeps: CliDeps = {
  io: defaultIO,
  createStore: (root) => new FileStore(root),
  openStore: (root) => FileStore.open(root),
  createEngine: (options) => new FetchEngine(options),
  env: process.env,
  now: () => new Date(),
};
