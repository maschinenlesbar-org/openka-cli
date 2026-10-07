// `ka sync` — the ingest command. Deterministic from end to end: discovery, fetch
// with conditional requests, the declared tier, then store and index.

import type { Command } from "commander";
import { OpenKaError, StoreError, UsageError } from "@maschinenlesbar.org/openka-lib-errors";
import { HostPacer } from "@maschinenlesbar.org/openka-lib-http";
import {
  SYNC_LIMIT_MIN,
  planSync,
  syncJobs,
  windowOf,
  type ProgressEvent,
  type SourceOutcome,
  type SyncPlan,
  type SyncReport,
} from "@maschinenlesbar.org/openka-lib-pipeline";
import { PERIOD_RANGE } from "@maschinenlesbar.org/openka-lib-models";
import { OCR_MODES, createPerceiver, type OcrMode } from "@maschinenlesbar.org/openka-lib-perceive";
import { createSource, sourceKeys } from "@maschinenlesbar.org/openka-lib-registry";
import { FileStore, checkCorpusVolumes, lockCorpus, queueProgressKey, spaceGuard, type SpaceGuard, type Store } from "@maschinenlesbar.org/openka-lib-store";
import { InterruptedRunError, type CliDeps, type CliIO, type InterruptSignal } from "../io.js";
import {
  action,
  addVolumeOptions,
  choiceOption,
  type ActionContext,
  parseBoundedInt,
  parseIsoDate,
  parseNonEmpty,
  printJson,
  toEngineOptions,
  volumeOptionsFrom,
} from "../shared.js";
import { formatBytes, formatCount, sanitizeForTerminal, truncate } from "../text.js";
import { SyncProgress } from "../progress.js";
import { JobLogs, QueueRound, collectJobSpec, finished, printSummary, selectJobs, type CliJob } from "./sync-jobs.js";

/**
 * The most of one warning or error line that is printed. These are this program's own
 * sentences, often with an upstream reason or URL inside; at 200 characters the part
 * that explained them was cut ("… from the aggregator rather …"). The cap stays only
 * to bound upstream text.
 */
const MESSAGE_WIDTH = 2000;

type Source = ReturnType<typeof createSource>;

/**
 * The most Anfragen one `ka sync` run may take on: a cap on the command, not a
 * rule of the library, whose `sync()` only needs a limit of at least
 * `SYNC_LIMIT_MIN`.
 */
const SYNC_LIMIT_CAP = 100_000;

export function registerSync(program: Command, deps: CliDeps): void {
  const command = program
    .command("sync")
    .description("fetch, extract and store Anfragen from one or more sources")
    .option(
      "--source <key[@window]>",
      "source to sync, repeatable: several run side by side under one corpus lock. A window of its own after @: " +
        "berlin@2025-01-01..2025-12-31, bund@period=21, bund@2026-01-01..,limit=50 — the shared --since/--until/--period/--limit " +
        `fill in what it leaves out (${sourceKeys().join(", ")})`,
      collectJobSpec,
    )
    .option("--all", "every source with an adapter of its own (not the parlamentsspiegel aggregator)")
    .option("--plan <file>", "run the jobs of a plan file ([[job]] tables: source, since, until, period, limit, log; see Usage.md)", parseNonEmpty)
    .option("--restart", "with --plan, run every job again, also those done in the plan's unfinished round")
    .option("--wait", "wait while another run holds the corpus, instead of exiting 3")
    .option("--dry-run", "discover only: count the Anfragen and estimate the download, fetching no document and writing nothing")
    .option("--since <date>", "only Anfragen dated on or after this date (YYYY-MM-DD)", parseIsoDate)
    .option("--until <date>", "only Anfragen dated on or before this date (YYYY-MM-DD)", parseIsoDate)
    // The window's rules are the library's (normalizeSyncWindow): these parsers
    // use the same date rule and bounds, so a typo fails before the corpus is
    // touched, and an --until before --since is refused by sync() itself.
    .option("--period <n>", "restrict to one legislative period", parseBoundedInt(...PERIOD_RANGE))
    .option("--limit <n>", "stop after this many Anfragen (per source)", parseBoundedInt(SYNC_LIMIT_MIN, SYNC_LIMIT_CAP))
    .option("--api-key <key>", "credential for sources that need one (overrides the env var)", parseNonEmpty)
    .option("--metadata-only", "download no documents: a new record abstains on qa, a stored one is rebuilt from its archived documents")
    .option("--force", "re-extract even when inputs and extractor version are unchanged")
    .option(
      "--ignore-robots",
      "fetch documents from a server whose robots.txt disallows it — your decision; the run warns once per host (the records do not record it)",
    )
    .addOption(choiceOption("--ocr <mode>", "OCR engine for the ocr tier", OCR_MODES))
    .option("--ocr-language <lang>", "traineddata language for OCR", parseNonEmpty)
    .option("--ocr-version <version>", "require exactly this OCR engine version", parseNonEmpty)
    .option("--ocr-traineddata <path>", "traineddata file to hash into the provenance record", parseNonEmpty)
    .option("--json", "print the sync report as JSON (an array of reports for several jobs, --all or --plan)");
  addVolumeOptions(command)
    .action(
      action(deps, async (ctx) => {
        const io = ctx.deps.io;
        const selection = selectJobs(ctx);
        const queue = selection.queue;
        let jobs = selection.jobs;

        const flagKey = ctx.opts["apiKey"] as string | undefined;
        const keyFor = (source: Source): string | undefined =>
          source.apiKeyEnv === undefined ? undefined : (flagKey ?? nonBlank(ctx.deps.env[source.apiKeyEnv]));
        if (ctx.opts["all"] === true) {
          // Named on its own, a source without its credential is an error, as it
          // always was. Under --all it is one of many, and failing the whole run
          // for the one source the user never asked for by name would make --all
          // unusable without a DIP key.
          const missing = (job: CliJob): string | undefined => {
            const env = createSource(job.spec.source).apiKeyEnv;
            return env !== undefined && flagKey === undefined && nonBlank(ctx.deps.env[env]) === undefined ? env : undefined;
          };
          for (const job of jobs) {
            const env = missing(job);
            if (env !== undefined) io.err(`Note: skipped ${job.label}: it needs a credential (--api-key or ${env}).`);
          }
          jobs = jobs.filter((job) => missing(job) === undefined);
        }
        const several = ctx.opts["all"] === true || queue !== undefined || jobs.length > 1;
        const store = ctx.store();
        if (ctx.opts["dryRun"] === true) {
          const skip = queue === undefined || !(store instanceof FileStore) || ctx.opts["restart"] === true ? undefined : doneEarlier(store, queue.path);
          if (skip !== undefined && skip.done.size > 0) noteDoneEarlier(io, jobs, skip.done, skip.started);
          await dryRun(ctx, skip === undefined ? jobs : jobs.filter((job) => !skip.done.has(job.label)), store, keyFor, several);
          return;
        }
        // Before anything is written — the lock file is the first write — so a corpus
        // on a FAT32 stick or a full disk is refused, not discovered by the run.
        const space = store instanceof FileStore ? preflight(ctx, store) : undefined;

        // The three OCR sub-options describe a model that only runs with --ocr.
        // Accepting them without it ran strict mode and said nothing, so a
        // corpus meant to pin tesseract 5.3.4 was built with no OCR at all.
        const ocrMode = (ctx.opts["ocr"] as OcrMode | undefined) ?? "off";
        const ocrOnly = (["ocrLanguage", "ocrVersion", "ocrTraineddata"] as const).filter(
          (key) => ctx.opts[key] !== undefined,
        );
        if (ocrMode === "off" && ocrOnly.length > 0) {
          const flags = ocrOnly.map((key) => `--${key.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`)}`);
          throw new UsageError(
            `${flags.join(", ")} only appl${flags.length === 1 ? "ies" : "y"} with --ocr tesseract or --ocr tesseract-js; ` +
              "without --ocr no model runs and the option would be ignored",
          );
        }

        // The engine and whether it can run here are the library's
        // (createPerceiver); the check above only names the flags together.
        const perceiver = await createPerceiver(ocrMode, {
          ...(ctx.opts["ocrLanguage"] === undefined ? {} : { language: ctx.opts["ocrLanguage"] as string }),
          ...(ctx.opts["ocrVersion"] === undefined ? {} : { requireVersion: ctx.opts["ocrVersion"] as string }),
          ...(ctx.opts["ocrTraineddata"] === undefined ? {} : { traineddataPath: ctx.opts["ocrTraineddata"] as string }),
        });

        const progress = ctx.global.quiet === true ? undefined : new SyncProgress(io, ctx.deps.now);
        const say = (text: string): void => (progress === undefined ? io.err(text) : progress.line(text));
        const logs = new JobLogs(io, ctx.deps.now, jobs);

        // Ctrl-C finishes the Anfrage in hand and saves the catalog; a second one
        // ends the process. A kill -9 cannot be caught: the next sync over the
        // window, or `ka reindex`, catalogues what that run stored.
        const controller = new AbortController();
        let caught: InterruptSignal | undefined;
        const stopListening = ctx.deps.onInterrupt?.((signal) => {
          caught = signal;
          controller.abort();
          say(
            `${signal === "SIGINT" ? "Interrupted" : "Terminated"} — finishing the current Anfrage and saving the ` +
              "catalog. Signal again to stop at once.",
          );
        });

        let outcomes: SourceOutcome[];
        let round: QueueRound | undefined;
        let toRun = jobs;
        try {
          // The command takes the corpus lock itself — syncJobs() re-enters it —
          // so that it can wait for it (--wait) and, before the first request, knows
          // what kind of volume the corpus is on.
          const purpose = `sync ${jobs.map((job) => `--source ${job.label}`).join(" ")}`;
          let release: () => void;
          try {
            release = await lockCorpus(store, queue === undefined ? purpose : `sync --plan ${queue.path}`, {
              wait: ctx.opts["wait"] === true,
              signal: controller.signal,
              onWaiting: (held) => io.err(`Waiting for the corpus: it is in use by another run (${sanitizeForTerminal(held.holder)}).`),
            });
          } catch (err) {
            if (caught !== undefined) throw new InterruptedRunError(caught, "stopped waiting for the corpus; nothing was synced.");
            throw err;
          }
          try {
            if (store instanceof FileStore && store.writesAppleDouble) warnAppleDouble(ctx.deps, store);
            if (queue !== undefined && store instanceof FileStore) {
              round = new QueueRound(store, queue.path, ctx.deps.now, ctx.opts["restart"] === true);
              const open = round;
              if (open.done.size > 0) noteDoneEarlier(io, jobs, open.done, open.started);
              toRun = jobs.filter((job) => !open.done.has(job.label));
            }
            if (toRun.length === 0) {
              outcomes = [];
            } else {
              // One pacing book for every job's engine: two jobs reaching one host
              // are paced together, so running them side by side never asks a host
              // for more than one job would. Each engine is its own, since a
              // source's politeness floor raises its engine's interval for good.
              const pacer = new HostPacer();
              outcomes = await syncJobs({
                jobs: toRun.map((job) => ({ label: job.label, source: createSource(job.spec.source), window: windowOf(job.spec) })),
                store,
                engineFor: () => ctx.deps.createEngine({ ...toEngineOptions(ctx.global), pacer }),
                apiKeyFor: keyFor,
                perceiver,
                now: ctx.deps.now,
                signal: controller.signal,
                ...(queue === undefined ? {} : { stopOnFailure: !queue.continueOnError }),
                ...(ctx.opts["metadataOnly"] === true ? { metadataOnly: true } : {}),
                ...(ctx.opts["force"] === true ? { force: true } : {}),
                ...(ctx.opts["ignoreRobots"] === true ? { ignoreRobots: true } : {}),
                ...(space === undefined ? {} : { space }),
                // Progress is stderr, so --json (which shapes stdout) keeps it.
                onStart: (job: string) => {
                  progress?.start(job);
                  logs.line(job, "started");
                },
                onDiscovered: (job: string, count: number) => {
                  progress?.discovered(job, count);
                  logs.line(job, `${count} Anfragen discovered`);
                },
                onProgress: (job: string, event: ProgressEvent) => {
                  progress?.update(job, event);
                  logs.line(job, `${event.index}/${event.total} ${event.action} ${event.id}${event.detail === undefined ? "" : `: ${event.detail}`}`);
                },
                onDone: (outcome: SourceOutcome) => {
                  progress?.finish(outcome.job);
                  logs.outcome(outcome);
                  // Recorded as each job ends, so a run killed later keeps it.
                  if (round !== undefined && finished(outcome)) round.markDone(outcome.job);
                },
              });
            }
          } finally {
            release();
          }
        } finally {
          progress?.close();
          stopListening?.();
        }

        const failed = outcomes.filter((outcome) => outcome.status === "failed");
        const done = outcomes.flatMap((outcome) => (outcome.status === "done" ? [outcome] : []));
        // A single source keeps the shape it always had: its report, and the error
        // it threw as the command's own.
        if (!several && failed[0] !== undefined) throw failed[0].error;

        const handled = (report: SyncReport): number => report.stored + report.unchanged + report.failed;
        const interrupted = done.filter((outcome) => outcome.report.interrupted);
        const notStarted = outcomes.filter((outcome) => outcome.status === "skipped" && outcome.reason === "interrupted");
        const stopped =
          caught !== undefined && (interrupted.length > 0 || notStarted.length > 0)
            ? new InterruptedRunError(
                caught,
                interrupted
                  .map((outcome) => `${outcome.job}: stopped after ${handled(outcome.report)} of ${outcome.report.discovered} Anfragen`)
                  .concat(notStarted.map((outcome) => `${outcome.job}: not started`))
                  .join("; ") + "; what was stored is catalogued. Run the same sync again to continue.",
              )
            : undefined;

        if (ctx.opts["json"] === true) {
          const run = new Map(outcomes.map((outcome) => [outcome.job, outcome]));
          const all = jobs.map((job) => run.get(job.label) ?? { job: job.label, source: job.spec.source, skipped: true, reason: "done-earlier" });
          printJson(ctx, several ? all.map((entry) => ("status" in entry ? outcomeJson(entry) : entry)) : done[0]?.report);
        } else {
          for (const outcome of done) printReport(io, outcome.job, outcome.report, several ? `${outcome.job}: ` : "");
          if (queue !== undefined) printSummary(io, jobs, new Map(outcomes.map((outcome) => [outcome.job, outcome])));
        }
        if (round !== undefined && round.closeIfComplete(jobs)) {
          io.err("Note: every job of the plan is done; its next run starts over.");
        } else if (round !== undefined && toRun.length > 0) {
          io.err(`Note: ${jobs.length - round.done.size} job(s) of the plan are not done; run it again to continue (--restart runs every job).`);
        }
        const afterFailure = outcomes.filter((outcome) => outcome.status === "skipped" && outcome.reason === "after-failure");
        if (afterFailure.length > 0) {
          io.err(`Note: ${afterFailure.length} job(s) not started, since a job failed and the plan sets continue_on_error = false.`);
        }
        for (const outcome of failed.slice(1)) {
          io.err(`error: ${outcome.job}: ${truncate(errorMessage(outcome.error), MESSAGE_WIDTH)}`);
        }
        if (stopped !== undefined) throw stopped;
        const low = done.filter((outcome) => outcome.report.lowSpace !== undefined);
        if (low.length > 0) {
          throw new StoreError(
            low
              .map((outcome) => `${outcome.job}: stopped after ${handled(outcome.report)} of ${outcome.report.discovered} Anfragen — ${outcome.report.lowSpace}`)
              .join("; ") + "; what was stored is catalogued. Free some space, then run the same sync again to continue.",
          );
        }
        if (failed[0] !== undefined) {
          if (several) io.err(`error: ${failed[0].job} failed:`);
          throw failed[0].error;
        }
        const empty = done.filter((outcome) => outcome.report.errors.length > 0 && outcome.report.stored === 0).map((outcome) => outcome.job);
        if (empty.length > 0) throw new OpenKaError(`${empty.join(", ")}: sync produced no records`);
      }),
    );
}

/** A plan's open round, read without the lock — for `--dry-run`, which writes nothing. */
function doneEarlier(store: FileStore, plan: string): { done: Set<string>; started: string } | undefined {
  const open = store.getQueueProgress(queueProgressKey(plan));
  return open === undefined ? undefined : { done: new Set(open.done), started: open.started };
}

function noteDoneEarlier(io: CliIO, jobs: readonly CliJob[], done: ReadonlySet<string>, started: string): void {
  const skipped = jobs.filter((job) => done.has(job.label)).map((job) => job.label);
  if (skipped.length === 0) return;
  io.err(
    `Note: skipping ${skipped.length} job(s) done in this plan's unfinished round (begun ${started}): ${skipped.join(", ")}. ` +
      "--restart runs them again.",
  );
}

/**
 * `ka sync --dry-run`: what each job's window holds and what a sync would download
 * (`planSync`). No lock, since nothing is written; one job after the other, on one
 * pacing book like a real run.
 */
async function dryRun(
  ctx: ActionContext,
  jobs: readonly CliJob[],
  store: Store,
  keyFor: (source: Source) => string | undefined,
  several: boolean,
): Promise<void> {
  const io = ctx.deps.io;
  const pacer = new HostPacer();
  const results: { job: string; source: string; plan?: SyncPlan; error?: unknown }[] = [];
  for (const job of jobs) {
    if (ctx.global.quiet !== true) io.err(`${job.label}: discovering (no document is downloaded)…`);
    const source = createSource(job.spec.source);
    const apiKey = keyFor(source);
    try {
      const plan = await planSync({
        source,
        store,
        engine: ctx.deps.createEngine({ ...toEngineOptions(ctx.global), pacer }),
        ...windowOf(job.spec),
        ...(apiKey === undefined ? {} : { apiKey }),
        ...(ctx.opts["metadataOnly"] === true ? { metadataOnly: true } : {}),
        ...(ctx.opts["ignoreRobots"] === true ? { ignoreRobots: true } : {}),
      });
      results.push({ job: job.label, source: source.key, plan });
    } catch (error) {
      if (!several) throw error;
      results.push({ job: job.label, source: source.key, error });
    }
  }
  const plans = results.flatMap((result) => (result.plan === undefined ? [] : [result.plan]));
  if (ctx.opts["json"] === true) {
    const json = results.map((result) =>
      result.plan === undefined
        ? { job: result.job, source: result.source, error: errorMessage(result.error) }
        : several
          ? { job: result.job, ...result.plan }
          : result.plan,
    );
    printJson(ctx, several ? json : json[0]);
  } else {
    for (const result of results) {
      if (result.plan === undefined) continue;
      const plan = result.plan;
      const prefix = several ? `${result.job}: ` : "";
      if (plan.blocked !== undefined) {
        io.out(`${plan.source} ${windowLabel(plan.window)}: blocked — nothing was looked at (see the warning)`);
      } else {
        io.out(
          `${plan.source} ${windowLabel(plan.window)}: ${formatCount(plan.discovered)} Anfragen discovered, ` +
            `${formatCount(plan.in_corpus)} already in corpus`,
        );
        io.out(`${prefix}documents to fetch: ${fetchLabel(plan, ctx.opts["metadataOnly"] === true)}`);
      }
      for (const warning of plan.warnings) io.err(`warning: ${prefix}${truncate(warning, MESSAGE_WIDTH)}`);
    }
    if (plans.length > 1) {
      const sum = (pick: (plan: SyncPlan) => number): number => plans.reduce((total, plan) => total + pick(plan), 0);
      const bytes = sum((plan) => plan.estimate?.total_bytes ?? 0);
      const unmeasured = plans.filter((plan) => plan.documents_to_fetch > 0 && plan.estimate === undefined).length;
      io.out(
        `total: ${formatCount(sum((plan) => plan.discovered))} Anfragen discovered, ${formatCount(sum((plan) => plan.in_corpus))} already in corpus, ` +
          `${formatCount(sum((plan) => plan.documents_to_fetch))} documents to fetch` +
          (bytes > 0 ? ` (≈ ${formatBytes(bytes)}${unmeasured > 0 ? `, ${unmeasured} job(s) unmeasured` : ""})` : ""),
      );
    }
  }
  if (store instanceof FileStore) dryRunSpace(ctx, store, plans);
  const failed = results.filter((result) => result.error !== undefined);
  for (const result of failed.slice(1)) io.err(`error: ${result.job}: ${truncate(errorMessage(result.error), MESSAGE_WIDTH)}`);
  if (failed[0] !== undefined) {
    io.err(`error: ${failed[0].job} failed:`);
    throw failed[0].error;
  }
}

/**
 * The volumes a sync is about to write to: a refused filesystem or less free space
 * than `--min-free` is a `StoreError` (exit 3) before the lock is taken; a network
 * filesystem is a warning. Returns the guard the run checks as it goes.
 */
function preflight(ctx: ActionContext, store: FileStore): SpaceGuard {
  const options = volumeOptionsFrom(ctx);
  const reports = checkCorpusVolumes(store, options);
  for (const warning of reports.flatMap((report) => report.warnings)) ctx.deps.io.err(`warning: ${sanitizeForTerminal(warning)}`);
  const problems = reports.flatMap((report) => report.problems);
  if (problems.length > 0) throw new StoreError(`${problems.map((problem) => problem.replace(/\.$/, "")).join("; ")}. Nothing was synced.`);
  return spaceGuard(store, options.minFreeBytes, options.probe);
}

/**
 * What `--dry-run` says about space: what a real sync would refuse, as warnings, and
 * whether the estimated documents fit beside the free space it keeps.
 */
function dryRunSpace(ctx: ActionContext, store: FileStore, plans: readonly SyncPlan[]): void {
  const io = ctx.deps.io;
  const options = volumeOptionsFrom(ctx);
  const reports = checkCorpusVolumes(store, options);
  for (const problem of reports.flatMap((report) => report.problems)) io.err(`warning: a sync would refuse: ${sanitizeForTerminal(problem)}`);
  for (const warning of reports.flatMap((report) => report.warnings)) io.err(`warning: ${sanitizeForTerminal(warning)}`);
  if (ctx.opts["metadataOnly"] === true) return;
  const bytes = plans.reduce((sum, plan) => sum + (plan.estimate?.total_bytes ?? 0), 0);
  const blobs = reports[reports.length - 1];
  if (bytes === 0 || blobs?.space === undefined) return;
  const problem = spaceGuard(store, options.minFreeBytes, options.probe).fitProblem(bytes);
  if (problem !== undefined) {
    io.err(`warning: ${sanitizeForTerminal(problem)}`);
  } else if (ctx.opts["json"] !== true) {
    io.out(`space: ≈ ${formatBytes(bytes)} to fetch, ${formatBytes(blobs.space.free)} free for ${sanitizeForTerminal(blobs.path)}`);
  }
}

/** The window a plan covers, in words: "2026-01-01..2026-12-31", "WP 19", "default window". */
function windowLabel(window: SyncPlan["window"]): string {
  const parts: string[] = [];
  if (window.since !== undefined || window.until !== undefined) parts.push(`${window.since ?? ""}..${window.until ?? ""}`);
  if (window.period !== undefined) parts.push(`WP ${window.period}`);
  if (window.limit !== undefined) parts.push(`first ${formatCount(window.limit)}`);
  return parts.length === 0 ? "(default window)" : parts.join(" ");
}

function fetchLabel(plan: SyncPlan, metadataOnly: boolean): string {
  if (metadataOnly) return "none (--metadata-only)";
  const count = formatCount(plan.documents_to_fetch);
  if (plan.documents_to_fetch === 0) return "none";
  const estimate = plan.estimate;
  if (estimate === undefined) return `${count} (size unknown: no document could be measured)`;
  const basis = estimate.basis === "corpus" ? `average of ${formatCount(estimate.sampled)} in the corpus` : `HEAD-sampled n=${estimate.sampled}`;
  return `${count} (≈ ${formatBytes(estimate.total_bytes)} at ${formatBytes(estimate.average_bytes)} avg; ${basis})`;
}

function nonBlank(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One job's outcome in `--json` output for several jobs: the report, with the job's label. */
function outcomeJson(outcome: SourceOutcome): unknown {
  if (outcome.status === "done") return { job: outcome.job, ...outcome.report };
  if (outcome.status === "skipped") return { job: outcome.job, source: outcome.source, skipped: true, reason: outcome.reason };
  return { job: outcome.job, source: outcome.source, error: errorMessage(outcome.error) };
}

/** The text summary of one report, named by its job; `prefix` names it again when several ran. */
function printReport(io: CliIO, label: string, report: SyncReport, prefix: string): void {
  if (report.upstreamUnchanged) {
    io.out(`${label}: upstream reports no change since the last sync — nothing to do.`);
    return;
  }
  if (report.blocked !== undefined) {
    // Not "0 discovered": nothing was looked at, and a cron job reading this must not
    // take it for a quiet day.
    io.out(`${label}: blocked — nothing was looked at, and the run is not recorded as a sync (see the warning)`);
    for (const warning of report.warnings) io.err(`warning: ${prefix}${truncate(warning, MESSAGE_WIDTH)}`);
    return;
  }
  io.out(
    `${label}: ${report.discovered} discovered, ${report.stored} stored, ` +
      `${report.unchanged} unchanged, ${report.failed} failed`,
  );
  if (report.needsReview > 0) {
    io.out(`${prefix}${report.needsReview} of the stored records have abstained fields — see \`ka review\`.`);
  }
  if (report.recatalogued > 0) {
    io.out(
      `${prefix}${report.recatalogued} unchanged record(s) were on disk but missing from the catalog ` +
        "(left by an interrupted run) and are searchable again.",
    );
  }
  for (const warning of report.warnings) io.err(`warning: ${prefix}${truncate(warning, MESSAGE_WIDTH)}`);
  for (const error of report.errors.slice(0, 10)) io.err(`error: ${prefix}${truncate(error, MESSAGE_WIDTH)}`);
  if (report.errors.length > 10) io.err(`… and ${report.errors.length - 10} more errors`);
}

/**
 * A corpus on a FAT32 or exFAT drive works, but costs twice the files: macOS writes
 * a `._` companion beside every one. `ka` skips them; this says so before the run
 * adds a few thousand more, and names the other limit of FAT32 that a flat
 * `records/` directory runs into.
 */
function warnAppleDouble(deps: CliDeps, store: FileStore): void {
  deps.io.err(
    `warning: ${sanitizeForTerminal(store.root)} is on a volume without extended attributes (FAT32 or exFAT), so macOS ` +
      "writes a ._ companion file beside every file of the corpus. ka ignores them, and `ka doctor --fix` removes them. " +
      "FAT32 also caps a directory at 65,534 entries, and a long file name takes several, so records/ tops out at " +
      "roughly 8,000–16,000 records there; APFS, HFS+ or ext4 have neither problem.",
  );
}
