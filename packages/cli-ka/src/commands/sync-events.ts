// `ka sync`'s event log (issue #10): one log record per event, written as it happens —
// for `tail -f | jq`, and to tell after an interrupted run what became of each Anfrage
// and why. Each event is a record of `ka.sync` (`log.ts`) whose fields follow `msg`:
//
//   {"ts":"…","level":"INFO","topic":"ka.sync","msg":"berlin: started","event":"start","job":"berlin","source":"berlin"}
//   {"ts":"…","level":"INFO","topic":"ka.sync","msg":"berlin: 2471 Anfragen discovered","event":"discovered",…,"count":2471}
//   {"ts":"…","level":"INFO","topic":"ka.sync","msg":"berlin-19-24986 stored","event":"record",…,"id":"berlin-19-24986","status":"stored","index":1,"total":2471,"ms":812,"bytes":141233,"abstained":["qa"]}
//   {"ts":"…","level":"WARN","topic":"ka.sync","msg":"19/24987 failed: HTTP 503 …","event":"record",…,"status":"failed","error":"HTTP 503 …"}
//   {"ts":"…","level":"WARN","topic":"ka.sync","msg":"berlin: …","event":"warning",…,"message":"…"}
//   {"ts":"…","level":"INFO","topic":"ka.sync","msg":"berlin: done — 2471 stored, 0 failed","event":"done",…,"stored":2471,…}
//   {"ts":"…","level":"ERROR","topic":"ka.sync","msg":"bund: failed: …","event":"failed",…,"error":"…"}
//   {"ts":"…","level":"INFO","topic":"ka.sync","msg":"report of 1 job(s)","event":"report","reports":[…]}   ← what --json prints
//
// With `--log-format jsonl` they go to stderr, in place of the progress line, among the
// run's other records; `--log-file` appends them to a file as JSON Lines whatever the
// format, with every other record of the run beside them. A record's `gaps` name the
// documents that were not fetched and why (404, robots, too large, …), with their URLs.

import type { ProgressEvent, SourceOutcome } from "@maschinenlesbar.org/openka-lib-pipeline";
import { UsageError } from "@maschinenlesbar.org/openka-lib-errors";
import type { CliIO } from "../io.js";
import { formatLogRecord, type LogLevel, type LogRecord, type Logger } from "../log.js";
import { statusOf } from "./sync-jobs.js";
import { ID_WIDTH, MESSAGE_WIDTH, truncate } from "../text.js";

export class SyncEvents {
  private file: string | undefined;
  private broken = false;

  constructor(
    private readonly io: CliIO,
    /** The run's logger: stderr, in the `--log-format`. */
    private readonly log: Logger,
    /** Whether the events go to stderr (`--log-format jsonl`); a log file gets them either way. */
    private readonly toStderr: boolean,
    /**
     * Where "cannot write the event log" goes: on a terminal above the redrawn progress
     * line (`SyncProgress.above`), not glued to it. Unset, the run's logger.
     */
    private readonly warn: (msg: string) => void = (msg) => log.warn("sync", msg),
  ) {}

  /**
   * Append every record of the run to a file (`--log-file`), as a job log is appended
   * to: the events, and — tapped from the run's logger — every other record written from
   * here on, down to the error `run()` ends a failed run with.
   */
  toFile(path: string): void {
    if (this.io.appendFile === undefined) throw new UsageError("--log-file cannot be written here.");
    this.file = path;
    this.log.tap((record) => this.append(record));
  }

  get active(): boolean {
    return this.toStderr || this.file !== undefined;
  }

  private append(record: LogRecord): void {
    const append = this.io.appendFile;
    if (this.file === undefined || this.broken || append === undefined) return;
    try {
      append(this.file, formatLogRecord(record, "jsonl") + "\n");
    } catch (err) {
      // A log that cannot be written is said once; the sync goes on without it.
      this.broken = true;
      this.warn(`cannot write the event log ${this.file}: ${err instanceof Error ? err.message : String(err)}; the sync goes on without it.`);
    }
  }

  emit(level: LogLevel, event: string, msg: string, fields: Record<string, unknown>): void {
    if (!this.active) return;
    const record = this.log.record(level, "sync", msg, { event, ...fields });
    // Written to stderr, the logger's tap appends it to the file; otherwise it goes there alone.
    if (this.toStderr) this.log.write(record);
    else this.append(record);
  }

  start(job: string, source: string): void {
    this.emit("INFO", "start", `${job}: started`, { job, source });
  }

  discovered(job: string, source: string, count: number): void {
    this.emit("INFO", "discovered", `${job}: ${count} Anfragen discovered`, { job, source, count });
  }

  record(job: string, source: string, event: ProgressEvent): void {
    const failed = event.action === "failed";
    // The message is for people and bounded like the text records; `id` and `error` keep the whole text.
    const id = truncate(event.id, ID_WIDTH);
    this.emit(failed ? "WARN" : "INFO", "record", failed ? `${id} failed: ${truncate(event.detail ?? "failed", MESSAGE_WIDTH)}` : `${id} ${event.action}`, {
      job,
      source,
      id: event.id,
      status: event.action,
      index: event.index,
      total: event.total,
      ...(event.ms === undefined ? {} : { ms: event.ms }),
      ...(event.bytes === undefined ? {} : { bytes: event.bytes }),
      ...(event.abstained === undefined || event.abstained.length === 0 ? {} : { abstained: event.abstained }),
      ...(event.gaps === undefined ? {} : { gaps: event.gaps }),
      ...(event.detail === undefined ? {} : { error: event.detail }),
    });
  }

  /** What became of a job: its warnings one by one, then its counts — or why it failed or did not start. */
  done(outcome: SourceOutcome): void {
    const ids = { job: outcome.job, source: outcome.source };
    if (outcome.status === "failed") {
      const error = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
      this.emit("ERROR", "failed", `${outcome.job}: failed: ${truncate(error, MESSAGE_WIDTH)}`, { ...ids, error });
      return;
    }
    if (outcome.status === "skipped") {
      // Not started because the user stopped the run is what was asked for; because an
      // earlier job failed, it is a job of the plan left undone.
      const interrupted = outcome.reason === "interrupted";
      const why = interrupted ? "the run was interrupted" : "an earlier job failed";
      this.emit(interrupted ? "INFO" : "WARN", "skipped", `${outcome.job}: not started: ${why}`, { ...ids, reason: outcome.reason });
      return;
    }
    const { warnings, errors, source: _source, ...counts } = outcome.report;
    for (const message of warnings) this.emit("WARN", "warning", `${outcome.job}: ${truncate(message, MESSAGE_WIDTH)}`, { ...ids, message });
    this.emit(
      counts.discoveryFailed === true ? "ERROR" : "INFO",
      "done",
      `${outcome.job}: ${statusOf(outcome)} — ${counts.stored} stored, ${counts.unchanged} unchanged, ${counts.failed} failed`,
      { ...ids, ...counts, errors: errors.length },
    );
  }

  /** The run's last event: what `--json` prints, so one log covers the whole run. */
  report(reports: readonly unknown[]): void {
    this.emit("INFO", "report", `report of ${reports.length} job(s)`, { reports });
  }
}
