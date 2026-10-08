// `ka sync`'s event log in JSON Lines (issue #10): one object per event, one line per
// object, written as it happens — for `tail -f | jq`, and to tell after an
// interrupted run what became of each Anfrage and why. The progress line and the
// `--json` report stay as they were; this is beside them.
//
//   {"ts":"…","event":"start","job":"berlin","source":"berlin"}
//   {"ts":"…","event":"discovered","job":"berlin","source":"berlin","count":2471}
//   {"ts":"…","event":"record","job":"berlin","source":"berlin","id":"berlin-19-24986","status":"stored","index":1,"total":2471,"ms":812,"bytes":141233,"abstained":["qa"]}
//   {"ts":"…","event":"record",…,"status":"failed","error":"HTTP 503 …"}
//   {"ts":"…","event":"warning","job":"berlin","source":"berlin","message":"…"}
//   {"ts":"…","event":"done","job":"berlin","source":"berlin","stored":2471,…}
//   {"ts":"…","event":"report","reports":[…]}            ← what --json prints
//
// A record's `gaps` name the documents that were not fetched and why (404, robots,
// too large, …), with their URLs.

import { isoInstant, type ProgressEvent, type SourceOutcome } from "@maschinenlesbar.org/openka-lib-pipeline";
import { UsageError } from "@maschinenlesbar.org/openka-lib-errors";
import type { CliIO } from "../io.js";
import { escapeControlChars } from "../text.js";

/** Where the events go. */
export type EventSink = (line: string) => void;

export class SyncEvents {
  private readonly sinks: { name: string; write: EventSink }[] = [];
  private readonly broken = new Set<string>();

  constructor(
    private readonly io: CliIO,
    private readonly now: () => Date,
  ) {}

  /** Write events to stderr, in place of the progress line (`--log-format jsonl`). */
  toStderr(err: (text: string) => void): void {
    this.sinks.push({ name: "stderr", write: err });
  }

  /** Append events to a file (`--log-file`), as a job log is appended to. */
  toFile(path: string): void {
    const append = this.io.appendFile;
    if (append === undefined) throw new UsageError("--log-file cannot be written here.");
    this.sinks.push({ name: path, write: (line) => append(path, line + "\n") });
  }

  get active(): boolean {
    return this.sinks.length > 0;
  }

  emit(event: string, fields: Record<string, unknown>): void {
    if (this.sinks.length === 0) return;
    // JSON.stringify leaves DEL and C1 raw; upstream text in a reason must not act on a terminal.
    const line = escapeControlChars(JSON.stringify({ ts: isoInstant(this.now()), event, ...fields }));
    for (const sink of this.sinks) {
      if (this.broken.has(sink.name)) continue;
      try {
        sink.write(line);
      } catch (err) {
        // A log that cannot be written is said once; the sync goes on without it.
        this.broken.add(sink.name);
        this.io.err(`warning: cannot write the event log ${sink.name}: ${err instanceof Error ? err.message : String(err)}; the sync goes on without it.`);
      }
    }
  }

  start(job: string, source: string): void {
    this.emit("start", { job, source });
  }

  discovered(job: string, source: string, count: number): void {
    this.emit("discovered", { job, source, count });
  }

  record(job: string, source: string, event: ProgressEvent): void {
    this.emit("record", {
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
      this.emit("failed", { ...ids, error: outcome.error instanceof Error ? outcome.error.message : String(outcome.error) });
      return;
    }
    if (outcome.status === "skipped") {
      this.emit("skipped", { ...ids, reason: outcome.reason });
      return;
    }
    const { warnings, errors, source: _source, ...counts } = outcome.report;
    for (const message of warnings) this.emit("warning", { ...ids, message });
    this.emit("done", { ...ids, ...counts, errors: errors.length });
  }
}
