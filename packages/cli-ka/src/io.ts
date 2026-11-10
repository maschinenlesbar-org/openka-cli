// I/O seam for the CLI. Everything the CLI reads from the world or writes to it
// goes through a deps object, so the whole program can be driven in-process by a
// test with a temporary corpus, a mocked transport and captured output — no
// subprocess, no network, no clock.

import {
  appendFileSync,
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
  type Stats,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
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
   * Write the `-o` file: whole or not at all (`writeOutFile`). Without `overwrite` the
   * file must not exist yet (EEXIST), a symbolic link included; with it, a link is
   * written through. A device or a FIFO is written in place.
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

/**
 * A write to stdout that did not reach it whole — a full disk, a file size limit
 * (`ulimit -f`), a quota. `run()` logs it as an ERROR record of `ka.output` and exits 1.
 */
export class OutputError extends OpenKaError {}

/** `fs.writeSync`'s buffer form: how many bytes of `data[offset, offset + length)` reached `fd`. */
export type WriteSyncFn = (fd: number, data: Buffer, offset: number, length: number) => number;

/**
 * What `CliIO.out` writes with: on a stdout redirected to a regular file, every byte with
 * `writeSync`, looping over short writes, and a write that fails (EFBIG, ENOSPC, EDQUOT)
 * throws `OutputError`. Node's own stream for a file drops `writeSync`'s count, so a
 * write cut short by `ulimit -f` or a full disk left a truncated file behind a run that
 * exited 0 with nothing on stderr. A pipe or a terminal (anything that is not a regular
 * file) stays with `stdout`, whose errors `handleOutputErrors` reports.
 */
export function stdoutWriter(stdout: Pick<NodeJS.WriteStream, "write"> = process.stdout, fd = 1, write: WriteSyncFn = writeSync): (text: string) => void {
  let toFile: boolean | undefined;
  return (text) => {
    toFile ??= isRegularFile(fd);
    if (!toFile) {
      stdout.write(text);
      return;
    }
    const data = Buffer.from(text, "utf8");
    let offset = 0;
    try {
      while (offset < data.length) {
        const written = write(fd, data, offset, data.length - offset);
        if (written <= 0) throw new Error(`wrote ${offset} of ${data.length} bytes`);
        offset += written;
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new OutputError(`Could not write to stdout: ${reason}`, { cause: err });
    }
  };
}

function isRegularFile(fd: number): boolean {
  try {
    return fstatSync(fd).isFile();
  } catch {
    return false;
  }
}

/**
 * Whose links `--force` follows (`linkTarget`): the caller's user id, and how a path's
 * owner and mode are read. The seam of the link rule, so a test can be another user
 * without root.
 */
export interface LinkOwners {
  /** The caller's user id; undefined where there is none (Windows), where no link is refused. */
  uid: number | undefined;
  /** The owner and mode of `path`: through links with `follow` (a directory), of the link itself without. */
  ownerOf(path: string, follow: boolean): { uid: number; mode: number };
}

/** The process's user and the real file system. */
const processOwners: LinkOwners = {
  uid: process.getuid?.(),
  ownerOf: (path, follow) => (follow ? statSync(path) : lstatSync(path)),
};

/** How `writeOutFile` writes the temporary file: an exclusive create. Injected by tests. */
export type WriteNewFile = (path: string, data: Buffer) => void;

const writeNewFile: WriteNewFile = (path, data) => writeFileSync(path, data, { flag: "wx" });

/** The longest file name most filesystems take, in bytes. */
const NAME_MAX = 255;

/**
 * Write `data` to the `-o` file so that it is either the whole new output or what it was
 * before. `( ulimit -f 100; ka export -o good.jsonl --force )` used to leave the first
 * 102,400 bytes under the final name — a new file half-written, a complete one replaced
 * by half of the next.
 *
 * - A regular file (or a name not there yet) gets a temporary file beside it, created
 *   exclusively and renamed over it. A new name is claimed first with an exclusive
 *   create, so a file that appears meanwhile is refused (EEXIST) as one that was there,
 *   and the claim is removed again if the write fails. A replaced file keeps its mode.
 * - An existing name needs `overwrite` (`--force`): EEXIST otherwise. With it, a symbolic
 *   link is written through — its target is replaced, a dangling link's target created —
 *   and the link stays a link, as a shell's `>` would leave it; but not a link another
 *   user made in a directory others can write to (`linkTarget`, EACCES).
 * - A target that is no regular file — `/dev/null`, a FIFO, a socket, `/dev/stdout`,
 *   anything under `/dev/` — is written in place, and needs no `--force`: nothing that
 *   existed can be lost. The descriptor opened decides (`writeInPlace`): one that is no
 *   stream by then, a regular file under `/dev/` too, is written as a file.
 * - A directory is EISDIR.
 */
export function writeOutFile(path: string, data: Buffer, overwrite: boolean, write: WriteNewFile = writeNewFile, owners: LinkOwners = processOwners): void {
  const entry = lstatOrUndefined(path);
  if (entry === undefined) return replaceAtomically(path, data, true, write);
  const followed = entry.isSymbolicLink() ? statOrUndefined(path) : entry;
  if (followed?.isDirectory() === true) {
    throw Object.assign(new Error(`EISDIR: illegal operation on a directory, open '${path}'`), { code: "EISDIR" });
  }
  // A stream is written in place; a path that is no stream by the time it is opened
  // takes the way of a file below (`writeInPlace` checks the descriptor).
  if (((followed !== undefined && !followed.isFile()) || isDevicePath(path)) && writeInPlace(path, data)) return;
  if (!overwrite) throw Object.assign(new Error(`EEXIST: file already exists, open '${path}'`), { code: "EEXIST" });
  if (!entry.isSymbolicLink()) return replaceAtomically(path, data, false, write);
  const target = linkTarget(path, owners);
  replaceAtomically(target, data, lstatOrUndefined(target) === undefined, write);
}

function replaceAtomically(target: string, data: Buffer, claim: boolean, write: WriteNewFile): void {
  if (claim) closeSync(openSync(target, "wx"));
  const temporary = temporaryPath(target);
  try {
    write(temporary, data);
    if (!claim) chmodSync(temporary, statSync(target).mode & 0o7777);
    renameSync(temporary, target);
  } catch (err) {
    rmSync(temporary, { force: true });
    if (claim) rmSync(target, { force: true });
    throw err;
  }
}

/** `.<name>.<pid>-<random>.tmp` beside `target`, the name shortened to stay within NAME_MAX. */
function temporaryPath(target: string): string {
  const suffix = `.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
  let name = basename(target);
  while (Buffer.byteLength(`.${name}${suffix}`) > NAME_MAX) name = [...name].slice(0, -1).join("");
  return join(dirname(target), `.${name}${suffix}`);
}

/** Most links followed for one `-o` path, as the kernel's ELOOP limit. */
const MAX_LINKS = 40;

/** The mode bits of a directory others share: sticky, or writable by others. */
const SHARED_DIRECTORY = 0o1002;

/**
 * The file a path names, through any symbolic links, so `--force` writes where a link
 * points: also when the link dangles, where the file it names is created. A loop
 * throws (ELOOP). A link is followed only when the caller or the owner of its directory
 * made it, or nobody else can write to that directory (neither sticky nor writable by
 * others): the rule of Linux's fs.protected_symlinks, checked at every hop, the last
 * dangling one too. The kernel never sees these links (they are read here and the file
 * is renamed onto the target), so its own check cannot apply: a link another user
 * planted in /tmp sent the output over any file the caller could replace (security
 * audit 2026-10-27). Such a link throws (EACCES), naming it.
 */
function linkTarget(path: string, owners: LinkOwners): string {
  let current = resolve(path);
  for (let hops = 0; hops <= MAX_LINKS; hops++) {
    let link: string;
    try {
      if (!lstatSync(current).isSymbolicLink()) return current;
      link = readlinkSync(current);
    } catch {
      return current; // nothing there (yet): this is the file to create
    }
    if (owners.uid !== undefined) {
      const owner = owners.ownerOf(current, false).uid;
      const dir = owners.ownerOf(dirname(current), true);
      if (owner !== owners.uid && owner !== dir.uid && (dir.mode & SHARED_DIRECTORY) !== 0) {
        throw Object.assign(new Error(`"${current}" is a link another user made in a directory others can write to; it is not followed`), { code: "EACCES" });
      }
    }
    current = resolve(dirname(current), link);
  }
  throw Object.assign(new Error(`ELOOP: too many symbolic links, open '${path}'`), { code: "ELOOP" });
}

/** A path that names an open descriptor: `/dev/stdout`, `/dev/stderr`, `/dev/fd/N`, `/proc/self/fd/N`. */
const DESCRIPTOR_PATH = /^\/dev\/(?:stdout|stderr|fd\/\d+)$|^\/proc\/self\/fd\/\d+$/;

/**
 * Write `data` to a stream target (a device, a FIFO, a socket, a descriptor path) in
 * place, every byte, and return true; or return false, writing nothing, when what the
 * path names by the time it is opened is no stream. The descriptor is checked, not the
 * name: a link switched to a regular file after the path was classified was truncated
 * and written without --force (security audit 2026-10-27). The open creates nothing (no
 * O_CREAT) and blocks as before, so a FIFO whose reader comes later still works.
 */
function writeInPlace(path: string, data: Buffer): boolean {
  // Append: on a descriptor path that leads to a file (`-o /dev/stdout >> log`), the
  // shell's own mode stands; on a device or a FIFO it makes no difference.
  let fd: number;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_APPEND);
  } catch (err) {
    // Linux cannot open a socket through its descriptor path (ENXIO), and a process
    // started with socket stdio has one: `-o /dev/stdout` is then written to the
    // descriptor the process already holds, which stays open.
    const own = descriptorOf(path);
    if ((err as { code?: unknown }).code !== "ENXIO" || own === undefined) throw err;
    writeAll(own, data);
    return true;
  }
  try {
    // A descriptor path keeps whatever the shell opened, a regular file too.
    const stats = fstatSync(fd);
    if (!DESCRIPTOR_PATH.test(path) && !stats.isFIFO() && !stats.isCharacterDevice() && !stats.isSocket()) return false;
    writeAll(fd, data);
    return true;
  } finally {
    closeSync(fd);
  }
}

/** The descriptor a descriptor path names (`/dev/stdout` 1, `/dev/fd/63` 63), else undefined. */
function descriptorOf(path: string): number | undefined {
  if (path === "/dev/stdout") return 1;
  if (path === "/dev/stderr") return 2;
  const n = /^\/(?:dev|proc\/self)\/fd\/(\d+)$/.exec(path)?.[1];
  return n === undefined ? undefined : Number(n);
}

/** A short pause for a non-blocking descriptor that is full (EAGAIN), without a busy loop. */
const pause = new Int32Array(new SharedArrayBuffer(4));

/**
 * Write all of `data` to `fd`, or throw. `writeSync` may write less than asked (a
 * file-size limit, a full disk): the rest is written in a loop, and the call that cannot
 * write throws (EFBIG, ENOSPC). A descriptor the shell made non-blocking answers EAGAIN
 * while the reader is behind: wait a moment and go on.
 */
function writeAll(fd: number, data: Buffer): void {
  for (let at = 0; at < data.length; ) {
    try {
      at += writeSync(fd, data, at);
    } catch (err) {
      if ((err as { code?: unknown }).code !== "EAGAIN") throw err;
      Atomics.wait(pause, 0, 0, 5);
    }
  }
}

function isDevicePath(path: string): boolean {
  const absolute = resolve(path);
  return absolute.startsWith("/dev/") || absolute.startsWith("/proc/");
}

function lstatOrUndefined(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (err) {
    if ((err as { code?: unknown }).code === "ENOENT") return undefined;
    throw err;
  }
}

function statOrUndefined(path: string): Stats | undefined {
  try {
    return statSync(path);
  } catch (err) {
    if ((err as { code?: unknown }).code === "ENOENT") return undefined;
    throw err;
  }
}

/** The signals an `-o` write finishes before, and the exit codes the shell gives them. */
const SIGNAL_EXIT = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const;

export interface DeferSignalsOptions {
  signals?: Pick<NodeJS.EventEmitter, "on" | "removeListener">;
  exit?: (code: number) => void;
  /** When the listeners go: after the signals a write held back have been delivered. */
  later?: (task: () => void) => void;
}

/**
 * Run `write` with SIGINT, SIGTERM and SIGHUP held back, then end the run with 130, 143
 * or 129 if one came. Without a listener, Node ends the process at once, in the middle
 * of a synchronous write — leaving the claimed name and the temporary file behind. A
 * signal is delivered on the event loop, after `write` returns, so the listeners stay
 * until the next turn of the loop (`later`) to receive it.
 */
export function deferSignals<T>(write: () => T, options: DeferSignalsOptions = {}): T {
  const signals = options.signals ?? process;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let running = true;
  let received: keyof typeof SIGNAL_EXIT | undefined;
  const listeners = (Object.keys(SIGNAL_EXIT) as (keyof typeof SIGNAL_EXIT)[]).map((signal) => {
    const listener = (): void => {
      if (running) received ??= signal;
      else exit(SIGNAL_EXIT[signal]);
    };
    signals.on(signal, listener);
    return [signal, listener] as const;
  });
  const remove = (): void => {
    for (const [signal, listener] of listeners) signals.removeListener(signal, listener);
  };
  try {
    return write();
  } finally {
    running = false;
    if (received !== undefined) {
      remove();
      exit(SIGNAL_EXIT[received]);
    } else {
      (options.later ?? ((task) => void setImmediate(task)))(remove);
    }
  }
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
 * at once, quietly. Any other stdout error logs one `Could not write to stdout: <message>`
 * ERROR record of `<program>.output` (in the `--log-format` of the process's argv) and exits 1. On stderr an EPIPE or ENOTCONN is ignored, so a failed run keeps its own exit code (2 for a usage error,
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
    log.error("output", `Could not write to stdout: ${err.message}`);
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

const writeStdout = stdoutWriter();

export const defaultIO: CliIO = {
  out: (text) => writeStdout(text + "\n"),
  err: (text) => process.stderr.write(text + "\n"),
  errIsTerminal: process.stderr.isTTY === true,
  errPartial: (text) => process.stderr.write(text),
  writeFile: (path, data, options) => deferSignals(() => writeOutFile(path, data, options?.overwrite === true)),
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
