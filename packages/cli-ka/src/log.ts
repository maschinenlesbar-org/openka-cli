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

import { escapeControlChars, sanitizeForTerminal } from "./text.js";

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

/**
 * One record as one line (text: the message's own line breaks stay, as in commander's
 * help after a usage error; jsonl: one line always, DEL and C1 escaped like any JSON
 * this CLI prints).
 */
export function formatLogRecord(record: LogRecord, format: LogFormat): string {
  if (format === "jsonl") {
    const fields = Object.entries(record.fields ?? {}).filter(([key]) => !RECORD_KEYS.has(key));
    return escapeControlChars(JSON.stringify({ ts: record.ts, level: record.level, topic: record.topic, msg: record.msg, ...Object.fromEntries(fields) }));
  }
  return `${record.ts} ${record.level.padEnd(5)} [${record.topic}] ${record.msg}`;
}

export interface Logger {
  readonly format: LogFormat;
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
 */
function cleanMessage(msg: string): string {
  return msg.split("\n").map(sanitizeForTerminal).join("\n");
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
    options.write(formatLogRecord(made, options.format));
    for (const listener of listeners) listener(made);
  };
  const log: Logger["log"] = (level, area, msg, fields) => write(record(level, area, msg, fields));
  return {
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
}

/** Why `value` is not a log format, or undefined. */
export function logFormatProblem(value: string): string | undefined {
  return (LOG_FORMATS as readonly string[]).includes(value) ? undefined : `Expected one of ${LOG_FORMATS.join(", ")}.`;
}

/**
 * The `--log-format` in `argv`, read before commander parses it: commander's own
 * usage errors are logged too, and they happen while parsing. A missing or unknown
 * value gives the default here; commander then reports an unknown one.
 */
export function logFormatFromArgv(argv: readonly string[]): LogFormat {
  let format: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (token === "--") break;
    if (token === "--log-format") format = argv[i + 1];
    else if (token.startsWith("--log-format=")) format = token.slice("--log-format=".length);
  }
  return format !== undefined && logFormatProblem(format) === undefined ? (format as LogFormat) : DEFAULT_LOG_FORMAT;
}
