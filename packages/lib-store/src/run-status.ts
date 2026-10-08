// What a running sync is doing, readable from another terminal (issue #15).
//
// The lock file said that something ran, and progress lived only on that process's
// stderr: a scheduler, a dashboard or a second terminal had to parse the human
// progress line out of a log. A sync now keeps `<corpus>/run/status.json`, replaced
// atomically as it goes and left behind with its result when it ends, and
// `readRunReport` joins it with the lock into one answer: running, idle (with the
// last run), a stale lock, or another writer.

import { hostname } from "node:os";
import type { FileStore } from "./file-store.js";

/** The status file is replaced at most this often while Anfragen go by. */
export const RUN_STATUS_EVERY_MS = 2000;
/** The rate a status reports is taken over this much of the recent past. */
export const RATE_WINDOW_MS = 10 * 60_000;
/** One progress sample per job is kept at most this often, for the recent rate. */
const SAMPLE_EVERY_MS = 15_000;

export type JobState = "waiting" | "discovering" | "running" | "done" | "blocked" | "failed" | "interrupted" | "low-space" | "not-started";

export interface JobStatus {
  job: string;
  source: string;
  state: JobState;
  /** Anfragen handled so far, and how many discovery found (once it has). */
  done: number;
  total?: number;
  failed: number;
  stored?: number;
  unchanged?: number;
  started_at?: string;
  discovered_at?: string;
  last_progress_at?: string;
  finished_at?: string;
  /** `[instant, done]` pairs of the last `RATE_WINDOW_MS`: what the recent rate is measured on. */
  samples: [string, number][];
  /** Why it failed or stopped. */
  message?: string;
}

export type RunResult = "finished" | "interrupted" | "failed" | "stopped";

export interface RunStatus {
  /** The command, as the lock names it: `sync --source berlin --source bund@period=21`. */
  command: string;
  pid: number;
  host: string;
  started_at: string;
  updated_at: string;
  running: boolean;
  finished_at?: string;
  /** How the run ended: every job through, a signal, a failure, or low disk space. */
  result?: RunResult;
  jobs: JobStatus[];
}

/** What a job ended as, in the terms the status file keeps. */
export interface JobEnd {
  state: Extract<JobState, "done" | "blocked" | "failed" | "interrupted" | "low-space" | "not-started">;
  discovered?: number;
  stored?: number;
  unchanged?: number;
  failed?: number;
  message?: string;
}

/**
 * Keeps a run's status file. Every call is cheap and never throws: the file is written
 * on a job's start, discovery and end, on the run's end, and in between at most every
 * `RUN_STATUS_EVERY_MS`; a write that fails goes to `onError` once, and the sync goes
 * on without a status — a status must not be what stops a sync.
 */
export class RunStatusRecorder {
  private readonly status: RunStatus;
  private lastWrite = Number.NEGATIVE_INFINITY;
  private failed = false;

  constructor(
    private readonly store: Pick<FileStore, "putRunStatus">,
    private readonly options: {
      command: string;
      jobs: readonly { job: string; source: string }[];
      now: () => Date;
      onError?: (err: unknown) => void;
    },
  ) {
    const at = this.instant();
    this.status = {
      command: options.command,
      pid: process.pid,
      host: hostname(),
      started_at: at,
      updated_at: at,
      running: true,
      jobs: options.jobs.map(({ job, source }) => ({ job, source, state: "waiting", done: 0, failed: 0, samples: [] })),
    };
    this.write(true);
  }

  start(job: string): void {
    const status = this.job(job);
    if (status === undefined) return;
    status.state = "discovering";
    status.started_at = this.instant();
    this.write(true);
  }

  discovered(job: string, total: number): void {
    const status = this.job(job);
    if (status === undefined) return;
    const at = this.instant();
    status.state = "running";
    status.total = total;
    status.discovered_at = at;
    status.samples = [[at, 0]];
    this.write(true);
  }

  progress(job: string, event: { index: number; total: number; action: string }): void {
    const status = this.job(job);
    if (status === undefined) return;
    const now = this.options.now();
    const at = instantOf(now);
    status.state = "running";
    status.done = event.index;
    status.total = event.total;
    if (event.action === "failed") status.failed++;
    status.last_progress_at = at;
    // The newest sample is always now; the one before it is dropped when it is not
    // `SAMPLE_EVERY_MS` past its own predecessor, so the samples stay spaced.
    status.samples.push([at, event.index]);
    const [older, middle] = [status.samples.at(-3), status.samples.at(-2)];
    if (older !== undefined && middle !== undefined && Date.parse(middle[0]) - Date.parse(older[0]) < SAMPLE_EVERY_MS) status.samples.splice(-2, 1);
    // A sample at the window's edge stays, so the window is always covered.
    while (status.samples.length > 2 && now.getTime() - Date.parse((status.samples[1] as [string, number])[0]) > RATE_WINDOW_MS) status.samples.shift();
    this.write(false);
  }

  done(job: string, end: JobEnd): void {
    const status = this.job(job);
    if (status === undefined) return;
    status.state = end.state;
    status.finished_at = this.instant();
    if (end.discovered !== undefined) status.total = end.discovered;
    if (end.stored !== undefined) status.stored = end.stored;
    if (end.unchanged !== undefined) status.unchanged = end.unchanged;
    if (end.failed !== undefined) status.failed = end.failed;
    if (end.message !== undefined) status.message = end.message;
    this.write(true);
  }

  /** The run is over: the file stays, as the last run's summary. */
  finish(result: RunResult): void {
    this.status.running = false;
    this.status.result = result;
    this.status.finished_at = this.instant();
    for (const job of this.status.jobs) if (job.state === "waiting") job.state = "not-started";
    this.write(true);
  }

  private job(label: string): JobStatus | undefined {
    return this.status.jobs.find((job) => job.job === label);
  }

  private instant(): string {
    return instantOf(this.options.now());
  }

  private write(force: boolean): void {
    if (this.failed) return;
    const now = this.options.now().getTime();
    if (!force && now - this.lastWrite < RUN_STATUS_EVERY_MS) return;
    this.lastWrite = now;
    this.status.updated_at = instantOf(new Date(now));
    try {
      this.store.putRunStatus(this.status);
    } catch (err) {
      this.failed = true;
      this.options.onError?.(err);
    }
  }
}

function instantOf(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** A job with what a reader needs: its recent rate and how long until it is done. */
export interface JobReport extends Omit<JobStatus, "samples"> {
  /** Anfragen per minute over the last `RATE_WINDOW_MS` of samples; absent until two are a while apart. */
  rate_per_min?: number;
  /** At that rate, seconds until `total`. */
  eta_seconds?: number;
  /** Seconds since the job last moved — a progress event, else discovery, else its start. */
  quiet_seconds?: number;
}

export interface RunReport {
  /**
   * `running`: a sync holds the corpus and keeps this status. `idle`: no lock — `run`
   * is the last run, if any. `stale`: the lock names a process on this host that is
   * gone. `busy`: another writer holds the corpus (`ka reindex`, `doctor --fix`), or
   * a sync on another host whose process cannot be checked from here.
   */
  state: "running" | "idle" | "stale" | "busy";
  /** The lock's holder, when there is a lock. */
  holder?: string;
  /** The live status, or the last run's. */
  run?: RunStatus;
  jobs: JobReport[];
  /** Seconds since any job of a running (or stale) run last moved. */
  quiet_seconds?: number;
  /** What the reader should know: a run that ended without recording its end, a status from another host. */
  notes: string[];
}

/** Join the lock and the status file into what `ka status` says. Writes nothing. */
export function readRunReport(store: Pick<FileStore, "lockStatus" | "getRunStatus">, now: Date): RunReport {
  const lock = store.lockStatus();
  const run = store.getRunStatus();
  const notes: string[] = [];
  const ours = run !== undefined && lock !== undefined && run.running && run.pid === lock.pid && run.host === lock.host;
  let state: RunReport["state"];
  if (lock === undefined) {
    state = "idle";
    if (run?.running === true) notes.push("the last run ended without recording its end (killed?); `ka sync` over the same window picks up where it stopped");
  } else if (lock.stale) {
    state = "stale";
    notes.push(`the lock was left by a run that is gone (${lock.holder}); the next writer takes it over`);
  } else if (ours) {
    state = "running";
    if (!lock.local) notes.push(`the run is on ${lock.host ?? "another host"}; whether its process is alive cannot be checked from here`);
  } else {
    state = "busy";
  }
  // A busy corpus's status file belongs to an earlier run, not to the holder.
  const shown = state === "busy" ? undefined : run;
  const jobs = (shown?.jobs ?? []).map((job) => jobReport(job, now, shown?.running === true && state !== "idle"));
  const report: RunReport = { state, jobs, notes };
  if (lock !== undefined) report.holder = lock.holder;
  if (shown !== undefined) report.run = shown;
  if (shown !== undefined && (state === "running" || state === "stale")) {
    const moved = shown.jobs.flatMap((job) => [job.last_progress_at, job.discovered_at, job.started_at, job.finished_at]).concat(shown.started_at);
    const latest = Math.max(...moved.flatMap((at) => (at === undefined ? [] : [Date.parse(at)])));
    report.quiet_seconds = Math.max(0, Math.round((now.getTime() - latest) / 1000));
  }
  return report;
}

function jobReport(job: JobStatus, now: Date, live: boolean): JobReport {
  const { samples, ...rest } = job;
  const report: JobReport = { ...rest };
  const first = samples[0];
  const last = samples.at(-1);
  if (first !== undefined && last !== undefined) {
    const minutes = (Date.parse(last[0]) - Date.parse(first[0])) / 60_000;
    if (minutes > 0 && last[1] > first[1]) {
      const rate = (last[1] - first[1]) / minutes;
      report.rate_per_min = Math.round(rate * 10) / 10;
      if (job.total !== undefined && job.state === "running") report.eta_seconds = Math.round(((job.total - job.done) / rate) * 60);
    }
  }
  if (live && (job.state === "running" || job.state === "discovering")) {
    const moved = job.last_progress_at ?? job.discovered_at ?? job.started_at;
    if (moved !== undefined) report.quiet_seconds = Math.max(0, Math.round((now.getTime() - Date.parse(moved)) / 1000));
  }
  return report;
}

/** Seconds from "90s", "10m", "2h", "1h30m" or a bare number of seconds; undefined when it is none. */
export function parseDurationSeconds(text: string): number | undefined {
  const trimmed = text.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(trimmed);
  if (match === null || trimmed === "") return undefined;
  const [, h = "0", m = "0", s = "0"] = match;
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

/** Why `text` is not a duration `parseDurationSeconds` reads (or is zero), or undefined. */
export function durationProblem(text: string): string | undefined {
  const seconds = parseDurationSeconds(text);
  return seconds === undefined || seconds <= 0 ? "Expected a duration such as 90s, 10m, 2h or 1h30m." : undefined;
}
