// I/O seam for the CLI. Everything the CLI reads from the world or writes to it
// goes through a deps object, so the whole program can be driven in-process by a
// test with a temporary corpus, a mocked transport and captured output — no
// subprocess, no network, no clock.

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { FileStore, systemVolumes, type FileStoreOptions, type VolumeProbe } from "@maschinenlesbar.org/openka-lib-store";
import { OpenKaError } from "@maschinenlesbar.org/openka-lib-errors";
import { FetchEngine, type EngineOptions } from "@maschinenlesbar.org/openka-lib-http";
import type { Store } from "@maschinenlesbar.org/openka-lib-store";

export interface CliIO {
  out(text: string): void;
  err(text: string): void;
  /**
   * Whether stderr is a terminal, where `ka sync` redraws its progress line in
   * place; anywhere else (a log file, a pipe) it prints plain lines.
   */
  errIsTerminal?: boolean;
  /** Write to stderr without a newline — only for redrawing a progress line on a terminal. */
  errPartial?(text: string): void;
  /**
   * Write a file. Without `overwrite` the file must not exist yet: an exclusive
   * create, which also never follows a symlink at the path.
   */
  writeFile(path: string, data: Buffer, options?: { overwrite?: boolean }): void;
  /**
   * Append to a file, creating it and its directory: a job log of `ka sync --plan`,
   * which a run adds to rather than replaces. Unset, job logs are not written.
   */
  appendFile?(path: string, text: string): void;
}

export interface CliDeps {
  io: CliIO;
  /** Open (or create) the corpus at `root`; `options.blobs` puts the documents elsewhere. */
  createStore(root: string, options?: FileStoreOptions): Store;
  /** Open the existing corpus at `root` for reading; a missing one is an error. */
  openStore(root: string, options?: FileStoreOptions): Store;
  createEngine(options: EngineOptions): FetchEngine;
  env: NodeJS.ProcessEnv;
  /** The clock. Injected so `retrieved_at` and feed timestamps are testable. */
  now(): Date;
  /**
   * Call `handler` on the first Ctrl-C or SIGTERM, and return a function that
   * stops listening. Only `ka sync` asks, so that an interrupt finishes the
   * Anfrage in hand and saves the catalog; a second signal is not caught and ends
   * the process as usual. Optional: a test harness without it cannot interrupt.
   */
  onInterrupt?(handler: (signal: InterruptSignal) => void): () => void;
  /**
   * What the corpus is stored on: filesystem and free space (`ka sync`'s preflight,
   * its space guard and `ka doctor`). Unset, the machine's own (`systemVolumes`).
   */
  volumes?: VolumeProbe;
}

/** The signals `ka sync` stops early on. */
export type InterruptSignal = "SIGINT" | "SIGTERM";

/**
 * A run that stopped early because it was asked to. `run()` exits with the shell's
 * code for the signal: 130 for SIGINT, 143 for SIGTERM.
 */
export class InterruptedRunError extends OpenKaError {
  readonly exitCode: number;
  constructor(signal: InterruptSignal, message: string) {
    super(message);
    this.name = "InterruptedRunError";
    this.exitCode = signal === "SIGINT" ? 130 : 143;
  }
}

function listenForInterrupts(handler: (signal: InterruptSignal) => void): () => void {
  const signals: InterruptSignal[] = ["SIGINT", "SIGTERM"];
  const listeners = signals.map((signal) => {
    const listener = (): void => {
      // The first signal is ours; the next one gets Node's default and ends the run.
      stop();
      handler(signal);
    };
    process.once(signal, listener);
    return [signal, listener] as const;
  });
  const stop = (): void => {
    for (const [signal, listener] of listeners) process.removeListener(signal, listener);
  };
  return stop;
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
 * EPIPE (ENOTCONN when stdout is a socket whose peer has gone, as when a Node parent
 * spawns `ka` with piped stdio on macOS). That is ordinary use, so the process exits 0
 * at once, quietly. Any other stdout error prints one `Output error: <message>` line
 * and exits 1. On stderr an EPIPE or ENOTCONN is ignored, so a failed run keeps its own exit code (2 for a usage error,
 * 3 for a corpus problem) when stderr's reader is gone; any other stderr error
 * exits 1 silently, since there is nowhere left to report it. Both bins install
 * this once, before `run()`.
 */
export function handleOutputErrors(
  streams: OutputStreams = process,
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  streams.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (readerGone(err)) return exit(0);
    process.stderr.write(`Output error: ${err.message}\n`);
    exit(1);
  });
  streams.stderr.on("error", (err: NodeJS.ErrnoException) => {
    if (!readerGone(err)) exit(1);
  });
}

/** True for the write errors that mean the reader has gone: EPIPE, or ENOTCONN on a socket. */
function readerGone(err: NodeJS.ErrnoException): boolean {
  return err.code === "EPIPE" || err.code === "ENOTCONN";
}

export const defaultIO: CliIO = {
  out: (text) => process.stdout.write(text + "\n"),
  err: (text) => process.stderr.write(text + "\n"),
  errIsTerminal: process.stderr.isTTY === true,
  errPartial: (text) => process.stderr.write(text),
  writeFile: (path, data, options) => writeFileSync(path, data, { flag: options?.overwrite === true ? "w" : "wx" }),
  appendFile: (path, text) => {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, text);
  },
};

export const defaultDeps: CliDeps = {
  io: defaultIO,
  createStore: (root, options) => new FileStore(root, options),
  openStore: (root, options) => FileStore.open(root, options),
  createEngine: (options) => new FetchEngine(options),
  env: process.env,
  now: () => new Date(),
  onInterrupt: listenForInterrupts,
  volumes: systemVolumes,
};
