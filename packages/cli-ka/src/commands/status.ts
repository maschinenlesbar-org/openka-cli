// `ka status` — what a running sync is doing, from another terminal: the lock and
// the status file a sync keeps (`readRunReport`, lib-store), as a few lines or as
// JSON for a scheduler or a dashboard (issue #15).

import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import { OpenKaError } from "@maschinenlesbar.org/openka-lib-errors";
import { FileStore, durationProblem, parseDurationSeconds, readRunReport, type JobReport, type RunReport } from "@maschinenlesbar.org/openka-lib-store";
import { logOf, type CliDeps, type CliIO } from "../io.js";
import type { Logger } from "../log.js";
import { duration } from "../progress.js";
import { action, printJson } from "../shared.js";
import { formatCount, sanitizeForTerminal } from "../text.js";

/** How often `--watch` looks again. */
export const WATCH_EVERY_MS = 5000;

/** commander value-parser: a duration such as 10m — the library's `durationProblem`. */
function parseDuration(value: string): number {
  const reason = durationProblem(value);
  if (reason !== undefined) throw new InvalidArgumentError(reason);
  return parseDurationSeconds(value) as number;
}

export function registerStatus(program: Command, deps: CliDeps): void {
  program
    .command("status")
    .description("what a running sync is doing — progress, rate, time left — or how the last one ended")
    .option("--json", "print the status as JSON")
    .option("--watch", `look again every ${WATCH_EVERY_MS / 1000} s until no sync runs`)
    .option("--stalled-after <duration>", "exit 1 when a running sync has not moved for this long (90s, 10m, 2h), or its process is gone", parseDuration)
    .action(
      action(deps, async (ctx) => {
        const store = ctx.existingStore();
        if (!(store instanceof FileStore)) throw new OpenKaError("ka status needs a corpus on disk.");
        const stalledAfter = ctx.opts["stalledAfter"] as number | undefined;
        for (let first = true; ; first = false) {
          if (!first) {
            await (ctx.deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(WATCH_EVERY_MS);
            if (ctx.opts["json"] !== true) ctx.deps.io.out("");
          }
          const now = ctx.deps.now();
          const report = readRunReport(store, now);
          if (ctx.opts["json"] === true) printJson(ctx, report);
          else printStatus(ctx.deps.io, logOf(ctx.deps), report, now);
          const stalled = stalledAfter === undefined ? undefined : stallOf(report, stalledAfter);
          if (stalled !== undefined) throw new OpenKaError(stalled);
          if (ctx.opts["watch"] !== true || report.state !== "running") return;
        }
      }),
    );
}

/** Why `--stalled-after` fails the command, or undefined. */
function stallOf(report: RunReport, seconds: number): string | undefined {
  if (report.state === "stale") return `stalled: the run that holds the corpus is gone (${report.holder ?? "unknown"})`;
  if (report.state === "running" && report.quiet_seconds !== undefined && report.quiet_seconds >= seconds) {
    return `stalled: nothing has moved for ${duration(report.quiet_seconds * 1000)} (--stalled-after ${duration(seconds * 1000)})`;
  }
  return undefined;
}

function printStatus(io: CliIO, log: Logger, report: RunReport, now: Date): void {
  const run = report.run;
  const since = (at: string): string => duration(now.getTime() - Date.parse(at));
  if (report.state === "busy") {
    io.out(`busy: the corpus is held by ${sanitizeForTerminal(report.holder ?? "another run")} — no progress is kept for it`);
  } else if (report.state === "idle") {
    if (run === undefined) {
      io.out("idle — no sync has recorded a status in this corpus yet");
    } else {
      const took = run.finished_at === undefined ? "" : ` after ${duration(Date.parse(run.finished_at) - Date.parse(run.started_at))}`;
      io.out(`idle — last run: ${sanitizeForTerminal(run.command)}, ${run.result ?? "ended"} ${run.finished_at ?? run.updated_at}${took}`);
    }
  } else if (run !== undefined) {
    const head = report.state === "stale" ? "stale lock — the process is gone; last status" : `running ${since(run.started_at)}`;
    io.out(`${sanitizeForTerminal(run.command)}   pid ${run.pid} on ${sanitizeForTerminal(run.host)}   ${head}`);
  } else {
    io.out(`stale lock: ${sanitizeForTerminal(report.holder ?? "unknown")} is gone; the next writer takes it over`);
  }
  for (const job of report.jobs) io.out(`  ${jobLine(job, now)}`);
  for (const note of report.notes) log.info("status", note);
}

function jobLine(job: JobReport, now: Date): string {
  const name = sanitizeForTerminal(job.job);
  const counts = (): string =>
    `${formatCount(job.total ?? 0)} discovered, ${formatCount(job.stored ?? 0)} stored, ${formatCount(job.unchanged ?? 0)} unchanged, ${formatCount(job.failed)} failed`;
  const why = job.message === undefined ? "" : ` — ${sanitizeForTerminal(job.message)}`;
  switch (job.state) {
    case "waiting":
      return `${name}: waiting`;
    case "discovering":
      return `${name}: discovering…${job.started_at === undefined ? "" : ` (for ${duration(now.getTime() - Date.parse(job.started_at))})`}`;
    case "running": {
      const parts = [`${name}: ${formatCount(job.done)}/${formatCount(job.total ?? 0)}`, `${formatCount(job.failed)} failed`];
      if (job.rate_per_min !== undefined) parts.push(`${job.rate_per_min}/min (last 10 min)`);
      if (job.quiet_seconds !== undefined) parts.push(`last progress ${duration(job.quiet_seconds * 1000)} ago`);
      if (job.eta_seconds !== undefined) parts.push(`~${duration(job.eta_seconds * 1000)} left`);
      return parts.join(" · ");
    }
    case "done":
    case "interrupted":
      return `${name}: ${job.state} · ${counts()}`;
    case "low-space":
      return `${name}: stopped, low on space · ${counts()}${why}`;
    case "blocked":
      return `${name}: blocked${why}`;
    case "failed":
      return `${name}: failed${why}`;
    case "not-started":
      return `${name}: not started${why}`;
  }
}
