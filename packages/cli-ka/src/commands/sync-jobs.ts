// The jobs one `ka sync` runs (issue #17): from `--source key@window` flags or a plan
// file, the logs a plan's jobs write, the plan's progress in the corpus, and the
// summary a plan run ends with. The rules — what a job spec or a plan file may say,
// how a window takes its defaults — are the library's (lib-pipeline's `jobs.ts` and
// `queue.ts`); this file only reads the command line into them.

import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { UsageError, assertValid } from "@maschinenlesbar.org/openka-lib-errors";
import {
  isoInstant,
  jobLabel,
  parseJobSpec,
  parseSyncQueue,
  withDefaults,
  type SourceOutcome,
  type SyncJobSpec,
  type SyncReport,
  type SyncWindow,
} from "@maschinenlesbar.org/openka-lib-pipeline";
import { adapterSourceKeys, sourceKeyProblem } from "@maschinenlesbar.org/openka-lib-registry";
import { queueProgressKey, type FileStore, type QueueProgress } from "@maschinenlesbar.org/openka-lib-store";
import { InvalidArgumentError } from "commander";
import type { CliIO } from "../io.js";
import type { ActionContext } from "../shared.js";
import { formatCount, pad, sanitizeForTerminal } from "../text.js";

/** One job as the command runs it. */
export interface CliJob {
  /** What output, logs and the plan's progress call it (`jobLabel`). */
  label: string;
  /** Its window: its own, with the defaults filled in. */
  spec: SyncJobSpec;
  /** Its log file, absolute, when it writes one. */
  log?: string;
}

export interface JobSelection {
  jobs: CliJob[];
  /** Set for `--plan`. */
  queue?: { path: string; continueOnError: boolean };
}

/** commander accumulator for a repeatable `--source key[@window]` — the library's `parseJobSpec`. */
export function collectJobSpec(value: string, previous: SyncJobSpec[] = []): SyncJobSpec[] {
  try {
    return previous.concat([parseJobSpec(value, { sourceProblem: sourceKeyProblem })]);
  } catch (err) {
    const reason = (err as { reason?: unknown }).reason;
    throw new InvalidArgumentError(typeof reason === "string" ? reason : err instanceof Error ? err.message : String(err));
  }
}

const WINDOW_FLAGS = [
  ["since", "--since"],
  ["until", "--until"],
  ["period", "--period"],
  ["limit", "--limit"],
] as const;

/**
 * The jobs the flags name: `--plan`, or `--source` (each with an optional window of its
 * own) / `--all`, the shared window flags filling in what a job does not set.
 */
export function selectJobs(ctx: ActionContext): JobSelection {
  const named = ctx.opts["source"] as SyncJobSpec[] | undefined;
  const all = ctx.opts["all"] === true;
  const plan = ctx.opts["plan"] as string | undefined;
  if (plan !== undefined) {
    if (named !== undefined || all) throw new UsageError("--plan names its own jobs; leave out --source and --all.");
    const given = WINDOW_FLAGS.filter(([key]) => ctx.opts[key] !== undefined).map(([, flag]) => flag);
    if (given.length > 0) {
      throw new UsageError(`--plan sets each job's window; put ${given.join(", ")} in the plan (a job, or its [defaults]) instead.`);
    }
    return readPlan(plan);
  }
  if (ctx.opts["restart"] === true) throw new UsageError("--restart applies to --plan only.");
  if (named === undefined && !all) throw new UsageError("Name a source with --source <key>, or sync every one with --all.");
  if (named !== undefined && all) throw new UsageError("--all already names every source; leave out --source.");
  const defaults: SyncWindow = {};
  for (const [key] of WINDOW_FLAGS) {
    const value = ctx.opts[key];
    if (value !== undefined) (defaults as Record<string, unknown>)[key] = value;
  }
  const specs = named ?? adapterSourceKeys().map((source) => ({ source }));
  // Named by what was typed (`bund`, `bund@period=21`), so a plain `--source berlin
  // --since …` keeps the name it always had; the window is checked with its defaults.
  const jobs = specs.map((spec) => ({ label: jobLabel(spec), spec: withDefaults(spec, defaults) }));
  assertValid("sources", jobs, (list) => {
    const seen = new Set<string>();
    for (const job of list) {
      if (seen.has(job.label)) return `"${job.label}" is named twice.`;
      seen.add(job.label);
    }
    return undefined;
  });
  return { jobs };
}

function readPlan(path: string): JobSelection {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new UsageError(`Could not read the plan ${path}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  const queue = parseSyncQueue(text, { where: path, sourceProblem: sourceKeyProblem });
  // A log path is relative to the plan file, so a plan run from cron or from another
  // directory writes where its author meant.
  const base = dirname(resolve(path));
  const jobs = queue.jobs.map(({ label, log, ...spec }) => ({
    label,
    spec,
    ...(log === undefined ? {} : { log: isAbsolute(log) ? log : resolve(base, log) }),
  }));
  return { jobs, queue: { path: resolve(path), continueOnError: queue.continueOnError } };
}

/**
 * The job logs of a run: one line per event, each stamped with the CLI's clock and the
 * job's label, appended — a log keeps every run of its job. A log that cannot be
 * written is said once on stderr and then left alone; the sync goes on.
 */
export class JobLogs {
  private readonly paths = new Map<string, string>();
  private readonly broken = new Set<string>();

  constructor(
    private readonly io: CliIO,
    private readonly now: () => Date,
    jobs: readonly CliJob[],
  ) {
    for (const job of jobs) if (job.log !== undefined) this.paths.set(job.label, job.log);
  }

  line(label: string, text: string): void {
    const path = this.paths.get(label);
    if (path === undefined || this.broken.has(path) || this.io.appendFile === undefined) return;
    try {
      this.io.appendFile(path, `${this.now().toISOString()} ${label} ${sanitizeForTerminal(text)}\n`);
    } catch (err) {
      this.broken.add(path);
      this.io.err(`warning: cannot write the log ${sanitizeForTerminal(path)}: ${err instanceof Error ? err.message : String(err)}; the sync goes on without it.`);
    }
  }

  /** What became of a job, with its report's warnings and errors in full. */
  outcome(outcome: SourceOutcome): void {
    const label = outcome.job;
    if (outcome.status === "skipped") {
      this.line(label, outcome.reason === "interrupted" ? "not started: the run was interrupted" : "not started: an earlier job failed");
      return;
    }
    if (outcome.status === "failed") {
      this.line(label, `failed: ${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}`);
      return;
    }
    const report = outcome.report;
    for (const warning of report.warnings) this.line(label, `warning: ${warning}`);
    for (const error of report.errors) this.line(label, `error: ${error}`);
    this.line(
      label,
      `${statusOf(outcome)}: ${report.discovered} discovered, ${report.stored} stored, ${report.unchanged} unchanged, ${report.failed} failed` +
        (report.lowSpace === undefined ? "" : ` — ${report.lowSpace}`),
    );
  }
}

/** A job's status in the summary and the log. */
export function statusOf(outcome: SourceOutcome): string {
  if (outcome.status === "failed") return "failed";
  if (outcome.status === "skipped") return "not started";
  const report: SyncReport = outcome.report;
  if (report.interrupted) return "interrupted";
  if (report.lowSpace !== undefined) return "low on space";
  if (report.blocked !== undefined) return "blocked";
  return "done";
}

/** Whether a job's window was covered, so a rerun of its plan may skip it. */
export function finished(outcome: SourceOutcome): boolean {
  return outcome.status === "done" && !outcome.report.interrupted && outcome.report.lowSpace === undefined;
}

/**
 * A plan's open round in the corpus: the jobs done since it opened. A rerun of the
 * plan skips them, so an interrupted queue continues where it stopped; when every job
 * is done the round closes, and the next run starts the plan over. Read and written
 * under the corpus lock.
 */
export class QueueRound {
  private readonly key: string;
  readonly done: Set<string>;
  readonly started: string;

  constructor(
    private readonly store: FileStore,
    private readonly plan: string,
    now: () => Date,
    restart: boolean,
  ) {
    this.key = queueProgressKey(plan);
    if (restart) store.putQueueProgress(this.key, undefined);
    const open = restart ? undefined : store.getQueueProgress(this.key);
    this.done = new Set(open?.done ?? []);
    this.started = open?.started ?? isoInstant(now());
  }

  markDone(label: string): void {
    this.done.add(label);
    const progress: QueueProgress = { plan: this.plan, started: this.started, done: [...this.done] };
    this.store.putQueueProgress(this.key, progress);
  }

  /** Close the round when every one of `jobs` is done; true when it did. */
  closeIfComplete(jobs: readonly CliJob[]): boolean {
    if (!jobs.every((job) => this.done.has(job.label))) return false;
    this.store.putQueueProgress(this.key, undefined);
    return true;
  }
}

/** The table a plan run ends with: one row per job of the plan, in its order. */
export function printSummary(io: CliIO, jobs: readonly CliJob[], outcomes: ReadonlyMap<string, SourceOutcome>): void {
  const width = Math.max(4, ...jobs.map((job) => job.label.length));
  const num = (n: number | undefined): string => (n === undefined ? "—" : formatCount(n)).padStart(10);
  io.out(`${pad("JOB", width)}  ${pad("STATUS", 13)}${"DISCOVERED".padStart(10)}${"STORED".padStart(10)}${"UNCHANGED".padStart(10)}${"FAILED".padStart(10)}`);
  for (const job of jobs) {
    const outcome = outcomes.get(job.label);
    const report = outcome?.status === "done" ? outcome.report : undefined;
    const status = outcome === undefined ? "done earlier" : statusOf(outcome);
    io.out(
      `${pad(job.label, width)}  ${pad(status, 13)}${num(report?.discovered)}${num(report?.stored)}${num(report?.unchanged)}${num(report?.failed)}`.trimEnd(),
    );
  }
}
