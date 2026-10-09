// I/O seam for the CLI. Everything the CLI reads from the world or writes to it
// goes through a deps object, so the whole program can be driven in-process by a
// test with a temporary corpus, a mocked transport and captured output — no
// subprocess, no network, no clock.

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { FileStore, systemVolumes, type FileStoreOptions, type VolumeProbe } from "@maschinenlesbar.org/openka-lib-store";
import { OpenKaError, UsageError } from "@maschinenlesbar.org/openka-lib-errors";
import { FetchEngine, type EngineOptions } from "@maschinenlesbar.org/openka-lib-http";
import type { Store } from "@maschinenlesbar.org/openka-lib-store";
import { createLogger, logFormatFromArgv, type Logger } from "./log.js";

export interface CliIO {
  out(text: string): void;
  err(text: string): void;
  /**
   * Whether stderr is a terminal, where `ka sync` redraws its progress line in
   * place; anywhere else (a log file, a pipe) it writes log records.
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
  /**
   * Read a secret for `ka config set`: on a terminal, after `prompt` on stderr and
   * without echo; from a pipe, the whole input. Never from argv. Unset, there is no
   * way in, and `ka config set` says so.
   */
  readSecret?(prompt: string): Promise<string>;
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
  /** Wait: only `ka status --watch`, between two looks. Unset, a timer. */
  sleep?(ms: number): Promise<void>;
  /**
   * Where diagnostics go: one record per line on stderr, in the `--log-format`
   * (`log.ts`), stamped by `now`. `run()` sets it from argv; deps without it log text
   * through `io.err`.
   */
  log?: Logger;
}

/** The deps' logger, or one that writes text records of `ka` through `io.err`. */
export function logOf(deps: Pick<CliDeps, "io" | "now" | "log">): Logger {
  return deps.log ?? createLogger({ format: "text", write: (line) => deps.io.err(line), now: () => deps.now() });
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
 * at once, quietly. Any other stdout error logs one `Output error: <message>` ERROR
 * record of `<program>.cli` (in the `--log-format` of the process's argv) and exits 1. On stderr an EPIPE or ENOTCONN is ignored, so a failed run keeps its own exit code (2 for a usage error,
 * 3 for a corpus problem) when stderr's reader is gone; any other stderr error
 * exits 1 silently, since there is nowhere left to report it. Both bins install
 * this once, before `run()`.
 */
export function handleOutputErrors(
  streams: OutputStreams = process,
  exit: (code: number) => void = (code) => process.exit(code),
  log: Logger = createLogger({ format: logFormatFromArgv(process.argv.slice(2)), write: (line) => process.stderr.write(line + "\n") }),
): void {
  streams.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (readerGone(err)) return exit(0);
    log.error("cli", `Output error: ${err.message}`);
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

/**
 * The longest secret `readSecretFrom` takes (64 KiB). Reading stops beyond it, so an
 * endless input (`< /dev/zero`) cannot grow memory without bound, and a value that
 * could never be sent as a header is not stored.
 */
export const MAX_SECRET_BYTES = 64 * 1024;

/**
 * True when `rest`, what followed a line break `brk` in the same read, holds more than
 * the LF of a CR LF and escape sequences (a bracketed-paste end marker).
 */
function moreAfterLineBreak(rest: string, brk: string): boolean {
  const tail = brk === "\r" && rest.startsWith("\n") ? rest.slice(1) : rest;
  // Built from char codes, so the source stays free of control bytes.
  const esc = String.fromCharCode(0x1b);
  const sequences = new RegExp(`${esc}\\[[0-?]*[ -/]*[@-~]|${esc}O.|${esc}`, "g");
  return tail.replace(sequences, "") !== "";
}

/** The refusal of a secret longer than `MAX_SECRET_BYTES`. */
function secretTooLong(): UsageError {
  return new UsageError("The value is longer than 64 KiB; nothing was stored.");
}

/**
 * `CliIO.readSecret` over real streams. From a pipe or a file (`< key.txt`, `printf %s
 * "$KEY" |`) the whole input, one trailing newline dropped. On a terminal the input is
 * read in raw mode, so nothing is echoed: Enter ends it, Backspace takes a character
 * back, Ctrl-C stops (exit 130, nothing stored) and Ctrl-D ends it like Enter. Escape
 * sequences (arrow keys, bracketed-paste markers) are dropped; any other character, a
 * tab included, is kept, so `ka config set` refuses what it would refuse from a pipe; a
 * paste with more after its first line break is refused. Either way a value longer than `MAX_SECRET_BYTES` is refused (`UsageError`), and reading
 * stops there.
 */
export async function readSecretFrom(
  stdin: NodeJS.ReadStream | NodeJS.ReadableStream,
  stderr: Pick<NodeJS.WriteStream, "write">,
  prompt: string,
): Promise<string> {
  const tty = stdin as NodeJS.ReadStream;
  if (tty.isTTY !== true || typeof tty.setRawMode !== "function") {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of stdin) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      chunks.push(buffer);
      bytes += buffer.length;
      // Room for the line break that is dropped below; leaving the loop destroys the stream.
      if (bytes > MAX_SECRET_BYTES + 2) throw secretTooLong();
    }
    const value = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
    if (Buffer.byteLength(value) > MAX_SECRET_BYTES) throw secretTooLong();
    return value;
  }
  stderr.write(prompt);
  return new Promise((resolve, reject) => {
    let value = "";
    // Where an escape sequence stands, across reads: after ESC, inside a CSI (`ESC [`
    // parameters… final, bracketed-paste markers included), before SS3's final (`ESC O x`).
    let escape: "none" | "esc" | "csi" | "ss3" = "none";
    const finish = (error?: Error): void => {
      tty.removeListener("data", onData);
      tty.setRawMode(false);
      tty.pause();
      stderr.write("\n");
      if (error === undefined) resolve(value);
      else reject(error);
    };
    const onData = (chunk: Buffer | string): void => {
      const chars = [...chunk.toString()];
      for (const [i, ch] of chars.entries()) {
        // An arrow key or a paste marker is a keystroke, not part of the value.
        if (escape === "csi") {
          if (ch >= "@" && ch <= "~") escape = "none";
          continue;
        }
        if (escape === "ss3") {
          escape = "none";
          continue;
        }
        if (escape === "esc") {
          escape = ch === "[" ? "csi" : ch === "O" ? "ss3" : "none";
          if (escape !== "none") continue;
        }
        if (ch === "\u001b") {
          escape = "esc";
          continue;
        }
        if (ch === "\r" || ch === "\n") {
          // A paste with more after its first line break: storing the first line alone
          // would keep a value the user did not mean, and leave the rest to the shell.
          if (moreAfterLineBreak(chars.slice(i + 1).join(""), ch)) {
            return finish(new UsageError("The value holds a line break; nothing was stored."));
          }
          return finish();
        }
        if (ch === "\u0004") return finish();
        if (ch === "\u0003") return finish(new InterruptedRunError("SIGINT", "nothing was stored."));
        if (ch === "\u007f" || ch === "\b") value = [...value].slice(0, -1).join("");
        // Any other character is kept, a tab or a control character included, so the
        // value is refused as the same input from a pipe is, not silently changed.
        else value += ch;
        if (value.length > MAX_SECRET_BYTES) return finish(secretTooLong());
      }
    };
    tty.setRawMode(true);
    tty.resume();
    tty.on("data", onData);
  });
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
  readSecret: (prompt) => readSecretFrom(process.stdin, process.stderr, prompt),
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
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
