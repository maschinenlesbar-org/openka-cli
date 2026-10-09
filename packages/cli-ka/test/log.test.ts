// The log on stderr: every diagnostic line is a record with a timestamp, a level and a
// topic — log4j-style text by default, one JSON object per line with `--log-format
// jsonl` — for `ka` and for `ka-factory`, commander's own usage errors included. The
// other tests read stderr untimed (`untimed`); the format itself is checked here.

import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { join } from "node:path";
import { FileStore, indexRecord } from "@maschinenlesbar.org/openka-lib-store";
import { sampleRecord } from "@maschinenlesbar.org/openka-lib-testing";
import { runFactory } from "@maschinenlesbar.org/openka-cli-ka-factory";
import type { SourceOutcome } from "@maschinenlesbar.org/openka-lib-pipeline";
import { EXIT_ERROR, EXIT_OK, EXIT_USAGE, run } from "../src/run.js";
import { handleOutputErrors, logOf, type CliIO } from "../src/io.js";
import { createLogger, escapeForRecord, formatLogRecord, logFormatFromArgv, logFormatProblem, type LogRecord } from "../src/log.js";
import { SyncEvents } from "../src/commands/sync-events.js";
import { cutText, truncate } from "../src/text.js";
import { JobLogs } from "../src/commands/sync-jobs.js";
import { cliHarness } from "./harness.js";

/** The harness's clock, as every record stamps it. */
const TS = "2026-01-02T03:04:05.000Z";

const records = (lines: readonly string[]): Record<string, unknown>[] =>
  lines.flatMap((chunk) => chunk.split("\n")).map((line) => JSON.parse(line) as Record<string, unknown>);

function seedOneRecord(corpus: string): void {
  const store = new FileStore(corpus);
  const record = sampleRecord();
  store.putRecord(record);
  indexRecord(store, record);
  store.flushCatalog();
}

describe("the log record", () => {
  const record: LogRecord = { ts: TS, level: "WARN", topic: "ka.sync", msg: "berlin: robots.txt disallows /" };

  it("is log4j style in text: time, level padded to five, [topic], message", () => {
    strictEqual(formatLogRecord(record, "text"), `${TS} WARN  [ka.sync] berlin: robots.txt disallows /`);
    strictEqual(formatLogRecord({ ...record, level: "ERROR" }, "text"), `${TS} ERROR [ka.sync] berlin: robots.txt disallows /`);
    strictEqual(formatLogRecord({ ...record, level: "INFO", fields: { event: "warning" } }, "text"), `${TS} INFO  [ka.sync] berlin: robots.txt disallows /`, "text shows the message only");
  });

  it("is one JSON object in jsonl, ts, level, topic and msg first, its own fields after — never in their place", () => {
    const line = formatLogRecord({ ...record, fields: { event: "warning", msg: "not this", ts: "nor this", job: "berlin" } }, "jsonl");
    deepStrictEqual(Object.keys(JSON.parse(line) as object), ["ts", "level", "topic", "msg", "event", "job"]);
    deepStrictEqual(JSON.parse(line), { ts: TS, level: "WARN", topic: "ka.sync", msg: "berlin: robots.txt disallows /", event: "warning", job: "berlin" });
    strictEqual(formatLogRecord({ ...record, msg: "a\u009bb" }, "jsonl").includes("\\u009b"), true, "C1 is escaped, as in every JSON the CLI prints");
  });

  it("sanitises every line of a message, in either format, and writes its line breaks as \\n", () => {
    const lines: string[] = [];
    const log = createLogger({ format: "text", write: (line) => lines.push(line), now: () => new Date(TS) });
    log.info("cli", "first\u001b[31m\nsecond‮");
    strictEqual(lines[0], `${TS} INFO  [ka.cli] first [31m\\nsecond`);
    // A trailing line break (OpenSSL's EPROTO message ends in one) says nothing.
    log.warn("http", "write EPROTO 0A00010B:SSL routines:wrong version number:\n");
    strictEqual(lines[1], `${TS} WARN  [ka.http] write EPROTO 0A00010B:SSL routines:wrong version number:`);
  });

  it("escapes whatever could split a record, forge one or steer a terminal (escapeForRecord)", () => {
    strictEqual(escapeForRecord("a\nb\rc\td"), "a\\nb\\rc\td", "LF and CR as \\n and \\r, TAB kept");
    strictEqual(escapeForRecord("\u001b[31m\u007f\u0085\u009b"), "\\u001b[31m\\u007f\\u0085\\u009b", "ESC, DEL, NEL, CSI");
    strictEqual(escapeForRecord("\u2028\u2029\u202e\u2066\u061c\u200e"), "\\u2028\\u2029\\u202e\\u2066\\u061c\\u200e", "separators and bidi");
    strictEqual(escapeForRecord("C:\\path ä €"), "C:\\path ä €", "backslashes and ordinary text stay");
  });

  it("is one line whatever reaches it: a forged record in the message or a field stays inside", () => {
    const forged = `19/1\n${TS} ERROR [ka.sync] FORGED\u2028x\u202ey`;
    for (const format of ["text", "jsonl"] as const) {
      const line = formatLogRecord({ ...record, msg: forged, fields: { id: forged, error: forged, reports: [{ errors: [forged] }] } }, format);
      ok(!/[\n\r\u2028\u2029\u202e]/.test(line), `${format}: ${line}`);
      if (format === "jsonl") {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        strictEqual(parsed["id"], forged, "the field keeps its value, escaped");
      }
    }
  });

  it("is well-formed: half a character becomes U+FFFD, in the message and in the fields (#13)", () => {
    const half = "berlin-19-1 \ud83d";
    strictEqual(formatLogRecord({ ...record, msg: half }, "text"), `${TS} WARN  [ka.sync] berlin-19-1 \ufffd`);
    const line = formatLogRecord({ ...record, msg: half, fields: { id: half, reports: [{ errors: [half] }] } }, "jsonl");
    ok(!/\\ud83d/.test(line), line);
    deepStrictEqual(JSON.parse(line), { ...record, msg: "berlin-19-1 \ufffd", id: "berlin-19-1 \ufffd", reports: [{ errors: ["berlin-19-1 \ufffd"] }] });
  });

  it("cuts a long text before a character, never inside one (truncate, cutText)", () => {
    // An emoji straddling the cut: one of the two splits a surrogate pair at any width.
    for (const text of ["\u{1f600}".repeat(1200), "a" + "\u{1f600}".repeat(1200)]) {
      for (const width of [40, 41, 2000, 2001]) {
        const cut = truncate(text, width);
        ok(cut.length <= width && !/[\ud800-\udbff](?![\udc00-\udfff])/.test(cut), `${width}: ${JSON.stringify(cut.slice(-3))}`);
      }
    }
    strictEqual(cutText("ab\u{1f600}", 3), "ab");
    strictEqual(cutText("ab\u{1f600}", 4), "ab\u{1f600}");
  });

  it("names the program first in every topic: ka by default, ka-factory for the factory", () => {
    const lines: string[] = [];
    createLogger({ format: "text", write: (line) => lines.push(line), now: () => new Date(TS), program: "ka-factory" }).warn("drift", "x");
    strictEqual(lines[0], `${TS} WARN  [ka-factory.drift] x`);
  });

  it("reads --log-format from argv before commander does, up to --", () => {
    strictEqual(logFormatFromArgv(["sync", "--log-format", "jsonl"]), "jsonl");
    strictEqual(logFormatFromArgv(["--log-format=jsonl", "search"]), "jsonl");
    strictEqual(logFormatFromArgv(["--log-format", "xml"]), "text", "an unknown one is commander's to refuse");
    strictEqual(logFormatFromArgv(["search", "--", "--log-format", "jsonl"]), "text");
    strictEqual(logFormatProblem("xml"), "Expected one of text, jsonl.");
  });

  it("hands every record written after a tap to the listener too", () => {
    const lines: string[] = [];
    const copies: LogRecord[] = [];
    const log = createLogger({ format: "text", write: (line) => lines.push(line), now: () => new Date(TS) });
    log.info("store", "before");
    log.tap((copy) => copies.push(copy));
    log.error("store", "gone");
    lines.shift();
    strictEqual(lines[0], `${TS} ERROR [ka.store] gone`);
    deepStrictEqual(copies, [{ ts: TS, level: "ERROR", topic: "ka.store", msg: "gone" }]);
  });
});

describe("ka's stderr", () => {
  it("is a text record by default: a usage error is an ERROR of ka.cli", async () => {
    const harness = cliHarness();
    try {
      strictEqual(await run(["search", "--nope"], harness.deps), EXIT_USAGE);
      strictEqual(harness.err[0], `${TS} ERROR [ka.cli] unknown option '--nope'`);
      ok(harness.err.slice(1).every((line) => line.startsWith(`${TS} INFO  [ka.cli] `)), "the help after it is an INFO record");
      deepStrictEqual(harness.out, []);
    } finally {
      harness.cleanup();
    }
  });

  it("is one JSON object per line with --log-format jsonl, before or after the command", async () => {
    for (const argv of [["--log-format", "jsonl", "search", "--nope"], ["search", "--nope", "--log-format=jsonl"]]) {
      const harness = cliHarness();
      try {
        strictEqual(await run(argv, harness.deps), EXIT_USAGE, argv.join(" "));
        const logged = records(harness.err);
        for (const entry of logged) {
          deepStrictEqual(Object.keys(entry), ["ts", "level", "topic", "msg"]);
          strictEqual(entry["ts"], TS);
        }
        deepStrictEqual(logged[0], { ts: TS, level: "ERROR", topic: "ka.cli", msg: "unknown option '--nope'" });
      } finally {
        harness.cleanup();
      }
    }
  });

  it("refuses an unknown --log-format as a usage error, in the text format", async () => {
    const harness = cliHarness();
    try {
      strictEqual(await run(["--log-format", "xml", "schema"], harness.deps), EXIT_USAGE);
      match(harness.err[0] ?? "", /^2026-01-02T03:04:05\.000Z ERROR \[ka\.cli\] option '--log-format <format>' argument 'xml' is invalid\. Expected one of text, jsonl\.$/);
      strictEqual(await run(["--log-format", "", "schema"], harness.deps), EXIT_USAGE);
    } finally {
      harness.cleanup();
    }
  });

  it("logs a note under the command's area and an error under the store's, and leaves stdout alone", async () => {
    const harness = cliHarness();
    try {
      seedOneRecord(harness.corpus);
      const out = join(harness.corpus, "export.csv");
      strictEqual(await run(["--log-format", "jsonl", "--corpus", harness.corpus, "export", "--out", out], harness.deps), EXIT_OK, harness.err.join("\n"));
      deepStrictEqual(
        records(harness.err).map((entry) => [entry["level"], entry["topic"], entry["msg"]]),
        [
          ["INFO", "ka.export", `Wrote ${harness.files.get(out)?.length} bytes to ${out}`],
          ["INFO", "ka.export", "1 record(s) exported."],
        ],
      );
      harness.err.length = 0;
      strictEqual(await run(["--corpus", join(harness.corpus, "missing"), "stats"], harness.deps), 3);
      match(harness.err[0] ?? "", /^2026-01-02T03:04:05\.000Z ERROR \[ka\.store\] No corpus at /);
      harness.err.length = 0;
      strictEqual(await run(["--corpus", harness.corpus, "get", "berlin-19-99999"], harness.deps), EXIT_ERROR);
      match(harness.err[0] ?? "", /^2026-01-02T03:04:05\.000Z ERROR \[ka\.get\] No record berlin-19-99999 in /);
      deepStrictEqual(harness.out, []);
    } finally {
      harness.cleanup();
    }
  });

  it("logs a stdout write error as an ERROR record of ka.cli", () => {
    const lines: string[] = [];
    const streams = { stdout: new EventEmitter(), stderr: new EventEmitter() };
    const exits: number[] = [];
    handleOutputErrors(streams as never, (code) => void exits.push(code), createLogger({ format: "jsonl", write: (line) => lines.push(line), now: () => new Date(TS) }));
    streams.stdout.emit("error", Object.assign(new Error("EIO"), { code: "EIO" }));
    deepStrictEqual(exits, [1]);
    deepStrictEqual(records(lines), [{ ts: TS, level: "ERROR", topic: "ka.cli", msg: "Output error: EIO" }]);
  });

  it("falls back to text records through io.err for deps without a logger", () => {
    const harness = cliHarness();
    try {
      logOf(harness.deps).warn("http", "slow");
      deepStrictEqual(harness.err, [`${TS} WARN  [ka.http] slow`]);
    } finally {
      harness.cleanup();
    }
  });
});

describe("ka-factory's stderr", () => {
  it("is the same records under the name ka-factory", async () => {
    const harness = cliHarness();
    try {
      strictEqual(await runFactory(["goldens", "list", "--nope"], harness.deps), EXIT_USAGE);
      strictEqual(harness.err[0], `${TS} ERROR [ka-factory.cli] unknown option '--nope'`);

      harness.err.length = 0;
      const empty = join(harness.corpus, "no-goldens");
      strictEqual(await runFactory(["--log-format", "jsonl", "goldens", "list", "--dir", empty], harness.deps), EXIT_ERROR);
      deepStrictEqual(records(harness.err), [{ ts: TS, level: "ERROR", topic: "ka-factory.goldens", msg: `No goldens in ${empty}.` }]);

      harness.err.length = 0;
      seedOneRecord(harness.corpus);
      strictEqual(await runFactory(["--log-format=jsonl", "--corpus", harness.corpus, "health", "--json", "--save-baseline"], harness.deps), EXIT_OK);
      deepStrictEqual(
        records(harness.err).map((entry) => [entry["level"], entry["topic"]]),
        [["INFO", "ka-factory.health"]],
      );
      ok(JSON.parse(harness.stdout()) !== undefined, "stdout keeps the JSON");
    } finally {
      harness.cleanup();
    }
  });
});

describe("the sync's own records", () => {
  /** An io whose appendFile throws for `broken` and keeps the rest. */
  function sink(broken?: string): { io: CliIO; files: Map<string, string>; err: string[] } {
    const files = new Map<string, string>();
    const err: string[] = [];
    return {
      files,
      err,
      io: {
        out: () => undefined,
        err: (text) => err.push(text),
        writeFile: () => undefined,
        appendFile: (path, text) => {
          if (path === broken) throw new Error("EACCES");
          files.set(path, (files.get(path) ?? "") + text);
        },
      },
    };
  }
  const now = (): Date => new Date(TS);

  it("gives each event its level: a failed Anfrage WARN, a failed job ERROR, a job left after a failure WARN", () => {
    const { io, err } = sink();
    const events = new SyncEvents(io, createLogger({ format: "jsonl", write: (line) => io.err(line), now }), true);
    events.record("berlin", "berlin", { index: 1, total: 2, id: "19/1", action: "failed", detail: "HTTP 500" });
    events.record("berlin", "berlin", { index: 2, total: 2, id: "berlin-19-2", action: "unchanged" });
    events.done({ status: "failed", job: "bund", source: "bund", error: new Error("HTTP 401") } as SourceOutcome);
    events.done({ status: "skipped", job: "hamburg", source: "hamburg", reason: "after-failure" } as SourceOutcome);
    events.done({ status: "skipped", job: "bremen", source: "bremen", reason: "interrupted" } as SourceOutcome);
    deepStrictEqual(
      records(err).map((entry) => [entry["level"], entry["event"], entry["msg"]]),
      [
        ["WARN", "record", "19/1 failed: HTTP 500"],
        ["INFO", "record", "berlin-19-2 unchanged"],
        ["ERROR", "failed", "bund: failed: HTTP 401"],
        ["WARN", "skipped", "hamburg: not started: an earlier job failed"],
        ["INFO", "skipped", "bremen: not started: the run was interrupted"],
      ],
    );
    deepStrictEqual(Object.keys(records(err)[0] ?? {}), ["ts", "level", "topic", "msg", "event", "job", "source", "id", "status", "index", "total", "error"]);
  });

  it("says once on stderr that the event log cannot be written, and goes on", () => {
    const { io, err } = sink("/events.jsonl");
    const log = createLogger({ format: "text", write: (line) => io.err(line), now });
    const events = new SyncEvents(io, log, false);
    events.toFile("/events.jsonl");
    log.info("sync", "one");
    log.info("sync", "two");
    deepStrictEqual(err, [
      `${TS} INFO  [ka.sync] one`,
      `${TS} WARN  [ka.sync] cannot write the event log /events.jsonl: EACCES; the sync goes on without it.`,
      `${TS} INFO  [ka.sync] two`,
    ]);
  });

  it("writes a plan's job log as text records, and says once that one cannot be written", () => {
    const { io, files, err } = sink("/broken.log");
    const log = createLogger({ format: "jsonl", write: (line) => io.err(line), now });
    const logs = new JobLogs(io, log, [
      { label: "berlin", spec: { source: "berlin" }, log: "/berlin.log" },
      { label: "bund", spec: { source: "bund" }, log: "/broken.log" },
    ]);
    logs.line("berlin", "INFO", "started");
    logs.outcome({ status: "failed", job: "berlin", source: "berlin", error: new Error("HTTP 503") } as SourceOutcome);
    logs.line("bund", "INFO", "started");
    logs.line("bund", "INFO", "again");
    strictEqual(files.get("/berlin.log"), `${TS} INFO  [ka.sync] berlin: started\n${TS} ERROR [ka.sync] berlin: failed: HTTP 503\n`, "text, whatever --log-format is");
    deepStrictEqual(records(err), [{ ts: TS, level: "WARN", topic: "ka.sync", msg: "cannot write the log /broken.log: EACCES; the sync goes on without it." }]);
  });

  it("keeps a job log one record per line, whatever the message or the label holds (02-1)", () => {
    const forgedLabel = `berlin@ref=19/1\n${TS} ERROR [ka.sync] FORGED label`;
    const forgedLog = `/dev/null/x\n${TS} ERROR [ka.sync] FORGED via log path`;
    const { io, files, err } = sink(forgedLog);
    const log = createLogger({ format: "text", write: (line) => io.err(line), now });
    const logs = new JobLogs(io, log, [
      { label: "berlin", spec: { source: "berlin" }, log: "/berlin.log" },
      { label: forgedLabel, spec: { source: "berlin" }, log: "/label.log" },
      { label: "bremen", spec: { source: "bremen" }, log: forgedLog },
    ]);
    // An EPROTO message ends in a newline.
    logs.line("berlin", "WARN", "1/3 failed 19/1: write EPROTO 0A00010B:SSL routines:wrong version number:\n");
    logs.line(forgedLabel, "INFO", "started");
    logs.line("bremen", "INFO", "started");
    strictEqual(files.get("/berlin.log"), `${TS} WARN  [ka.sync] berlin: 1/3 failed 19/1: write EPROTO 0A00010B:SSL routines:wrong version number:\n`);
    strictEqual(files.get("/label.log")?.split("\n").length, 2, String(files.get("/label.log")));
    strictEqual(err.length, 1, err.join("\n"));
    ok(err.every((line) => line.startsWith(`${TS} WARN  [ka.sync] cannot write the log /dev/null/x\\n`)), err.join("\n"));
  });
});
