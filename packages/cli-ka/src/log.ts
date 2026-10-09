// The CLI's log: every diagnostic line on stderr — errors, warnings, notes, `ka sync`'s
// progress off a terminal — is one record with a timestamp, a level and a topic. Two
// formats, chosen with the global `--log-format`:
//
//   text   2026-10-09T14:03:12.481Z WARN  [ka.sync] berlin: robots.txt disallows …
//   jsonl  {"ts":"2026-10-09T14:03:12.481Z","level":"WARN","topic":"ka.sync","msg":"…"}
//
// The text form follows log4j's pattern (`%d %-5p [%c] %m`), with the time in UTC
// ISO 8601. The topic is a dotted logger name: the program, then the area the record
// comes from (`ka.cli`, `ka.sync`, `ka.store`, `ka-factory.goldens`, …). A jsonl record
// may carry fields of its own after `msg` — `ka sync`'s events do; the text form shows
// the message only. stdout carries data only and is not touched; neither is
// `--help`/`--version`, the no-echo prompt of `ka config set`, nor the progress line a
// terminal redraws in place.
//
// Both bins share this module: `ka-factory` builds its logger with its own program name.

import { cutText, sanitizeForTerminal, toWellFormed } from "./text.js";

/** The log formats `--log-format` takes. */
export const LOG_FORMATS = ["text", "jsonl"] as const;
export type LogFormat = (typeof LOG_FORMATS)[number];

/** The format without `--log-format`. */
export const DEFAULT_LOG_FORMAT: LogFormat = "text";

export type LogLevel = "ERROR" | "WARN" | "INFO";

/** The program's name in every topic of the `ka` bin: `ka.<area>`. */
export const LOG_PROGRAM = "ka";

/** The keys every record starts with, in this order; a record's own fields never replace them. */
const RECORD_KEYS = new Set(["ts", "level", "topic", "msg"]);

export interface LogRecord {
  /** ISO 8601, UTC, milliseconds. */
  ts: string;
  level: LogLevel;
  /** `<program>.<area>`, like `ka.sync`. */
  topic: string;
  msg: string;
  /** More of the record, after `msg` in jsonl (`ka sync`'s events); the text form leaves them out. */
  fields?: Record<string, unknown>;
}

/** True for a character a record never carries raw (see `escapeForRecord`). */
function escapedInRecords(c: number): boolean {
  return (
    (c < 0x20 && c !== 0x09) || // C0 but TAB
    (c >= 0x7f && c <= 0x9f) || // DEL and C1 (NEL, the 8-bit CSI)
    c === 0x2028 || c === 0x2029 || // line and paragraph separator
    c === 0x061c || c === 0x200e || c === 0x200f || // bidi marks
    (c >= 0x202a && c <= 0x202e) || // bidi embeddings and overrides
    (c >= 0x2066 && c <= 0x2069) // bidi isolates
  );
}

/**
 * `text` with every character that could split a record, forge a second one or steer
 * the terminal written as an escape: CR as `\r`, LF as `\n`, any other C0 control but
 * TAB, DEL and C1 as `\u00XX`, U+2028, U+2029 and the bidi controls (U+061C, U+200E,
 * U+200F, U+202A–U+202E, U+2066–U+2069) as `\uXXXX`. Backslashes stay as they are. On
 * the output of `JSON.stringify` (no raw C0 left) every escape it adds is valid JSON,
 * so the same helper serves both formats. Checked by char code, so the source stays
 * free of those characters.
 */
export function escapeForRecord(text: string): string {
  let out = "";
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (!escapedInRecords(c)) continue;
    const escaped = c === 0x0d ? "\\r" : c === 0x0a ? "\\n" : "\\u" + c.toString(16).padStart(4, "0");
    out += text.slice(from, i) + escaped;
    from = i + 1;
  }
  return from === 0 ? text : out + text.slice(from);
}

/**
 * The longest message (in characters) a record carries. A longer one is cut at a
 * code-point boundary and ends in `… (N more characters)`: one huge server text, feed
 * reference or typed value cannot flood stderr, a job log or a log store with a line of
 * megabytes. Own messages that quote upstream data are bounded at their source too
 * (`truncate`); this is the backstop for every path. A record's own fields (`ka sync`'s
 * events) are data and stay whole.
 */
export const MAX_RECORD_MESSAGE = 4000;

/** `msg` within `MAX_RECORD_MESSAGE`, the cut marked with the number of characters left out. */
function boundRecordMessage(msg: string): string {
  if (msg.length <= MAX_RECORD_MESSAGE) return msg;
  const kept = cutText(msg, MAX_RECORD_MESSAGE);
  return `${kept}… (${codePoints(msg, kept.length)} more characters)`;
}

/** The number of characters (code points) in `text` from `from` on. */
function codePoints(text: string, from: number): number {
  let n = 0;
  for (let i = from; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // The low half of a pair is not a character of its own.
    if (c >= 0xdc00 && c <= 0xdfff && i > from && text.charCodeAt(i - 1) >= 0xd800 && text.charCodeAt(i - 1) <= 0xdbff) continue;
    n++;
  }
  return n;
}

/**
 * One record as one line, whatever the message holds: `escapeForRecord` runs over the
 * message (text) or over the whole JSON object, its own fields included (jsonl), so no
 * text that reaches a record — a server's, a feed's, the user's — can split it, forge
 * another one, or reach the terminal as a control sequence. A plan's job log is this
 * text form too.
 */
export function formatLogRecord(record: LogRecord, format: LogFormat): string {
  // Well-formed first: half a character would be `\ud83d` in jsonl, which jq rejects,
  // stopping the whole stream.
  const msg = toWellFormed(boundRecordMessage(record.msg));
  if (format === "jsonl") {
    const fields = Object.entries(record.fields ?? {}).filter(([key]) => !RECORD_KEYS.has(key));
    const wellFormed = (_key: string, value: unknown): unknown => (typeof value === "string" ? toWellFormed(value) : value);
    return escapeForRecord(JSON.stringify({ ts: record.ts, level: record.level, topic: record.topic, msg, ...Object.fromEntries(fields) }, wellFormed));
  }
  return `${record.ts} ${record.level.padEnd(5)} [${record.topic}] ${escapeForRecord(msg)}`;
}

export interface Logger {
  /**
   * The format records are written in. Mutable for one reason: it is read from argv
   * before commander parses (for commander's own errors), then set again from what
   * commander parsed, before the action runs (`followParsedLogFormat`).
   */
  format: LogFormat;
  /** The first part of every topic: `ka`, `ka-factory`. */
  readonly program: string;
  error(area: string, msg: string, fields?: Record<string, unknown>): void;
  warn(area: string, msg: string, fields?: Record<string, unknown>): void;
  info(area: string, msg: string, fields?: Record<string, unknown>): void;
  log(level: LogLevel, area: string, msg: string, fields?: Record<string, unknown>): void;
  /**
   * A record stamped now, for this program and `area`, without writing it — for a
   * record that goes to more than one place (`ka sync`'s events, a plan's job logs).
   */
  record(level: LogLevel, area: string, msg: string, fields?: Record<string, unknown>): LogRecord;
  /** Write a record made by `record`. */
  write(record: LogRecord): void;
  /**
   * Hand every record written from now on to `listener` too — `ka sync --log-file`,
   * which so receives the rest of the run, down to the error `run()` ends it with.
   */
  tap(listener: (record: LogRecord) => void): void;
}

/**
 * Every message is upstream data as often as not — a URL, a reason, a record id — so
 * each of its lines is sanitised like any other line the CLI prints, in either format.
 * A line break inside stays, for `formatLogRecord` to write as `\n`; one at the end
 * (OpenSSL's EPROTO message has one) says nothing and goes.
 */
function cleanMessage(msg: string): string {
  return msg.replace(/[\r\n]+$/, "").split("\n").map(sanitizeForTerminal).join("\n");
}

/** A logger that writes each record, formatted, to `write` (stderr: `CliIO.err`). */
export function createLogger(options: { format: LogFormat; write: (line: string) => void; now?: () => Date; program?: string }): Logger {
  const now = options.now ?? (() => new Date());
  const program = options.program ?? LOG_PROGRAM;
  const listeners: ((record: LogRecord) => void)[] = [];
  const record: Logger["record"] = (level, area, msg, fields) => ({
    ts: now().toISOString(),
    level,
    topic: `${program}.${area}`,
    msg: cleanMessage(msg),
    ...(fields === undefined ? {} : { fields }),
  });
  const write: Logger["write"] = (made) => {
    options.write(formatLogRecord(made, logger.format));
    for (const listener of listeners) listener(made);
  };
  const log: Logger["log"] = (level, area, msg, fields) => write(record(level, area, msg, fields));
  const logger: Logger = {
    format: options.format,
    program,
    record,
    write,
    log,
    tap: (listener) => void listeners.push(listener),
    error: (area, msg, fields) => log("ERROR", area, msg, fields),
    warn: (area, msg, fields) => log("WARN", area, msg, fields),
    info: (area, msg, fields) => log("INFO", area, msg, fields),
  };
  return logger;
}

/** Why `value` is not a log format, or undefined. */
export function logFormatProblem(value: string): string | undefined {
  return (LOG_FORMATS as readonly string[]).includes(value) ? undefined : `Expected one of ${LOG_FORMATS.join(", ")}.`;
}

/**
 * The `--log-format` in `argv`, read before commander parses it: commander's own
 * usage errors are logged too, and they happen while parsing. A missing or unknown
 * value gives the default here; commander then reports an unknown one; the last one
 * counts, as in commander. This scan is only for the records of a parse error: once
 * commander has parsed argv, its value is the format (`followParsedLogFormat`), so
 * `--user-agent --log-format=jsonl` (a User-Agent) logs text, and `ka sync` draws its
 * progress line. `valueOptions` names the program's options that take a value
 * (`--user-agent`): the token after one is its value, never an option, as commander
 * reads it, so `--user-agent --log-format jsonl` and `--user-agent -- --log-format jsonl`
 * agree with commander in a parse error too. A subcommand's value option does not
 * count: commander takes the program's own options out of argv first.
 */
export function logFormatFromArgv(argv: readonly string[], valueOptions: ReadonlySet<string> = new Set()): LogFormat {
  let format: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (token === "--") break;
    if (token === "--log-format") format = argv[++i];
    else if (token.startsWith("--log-format=")) format = token.slice("--log-format=".length);
    else if (valueOptions.has(token)) i++;
  }
  return format !== undefined && logFormatProblem(format) === undefined ? (format as LogFormat) : DEFAULT_LOG_FORMAT;
}

/** What `installWarningLog` needs of the process. */
export interface WarningSource {
  removeAllListeners(event: "warning"): unknown;
  on(event: "warning", listener: (warning: Error) => void): unknown;
}

/**
 * Node's own process warnings (`(node:PID) Warning: …`, e.g. for
 * `NODE_TLS_REJECT_UNAUTHORIZED=0`) as WARN records of `<program>.cli`:
 * `(node) <name>: <message>`, in the log's format. Node's default listener, which
 * prints the plain line, is removed (that silences it; `--no-warnings` is not needed).
 * Both bin shims install it once, before `run()`; a warning Node emits while it starts
 * up, before any code runs, stays Node's.
 */
export function installWarningLog(source: WarningSource, log: Pick<Logger, "warn">): void {
  source.removeAllListeners("warning");
  source.on("warning", (warning) => log.warn("cli", `(node) ${warning.name}: ${warning.message}`));
}
