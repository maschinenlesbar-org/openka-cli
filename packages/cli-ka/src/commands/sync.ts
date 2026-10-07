// `ka sync` — the ingest command. Deterministic from end to end: discovery, fetch
// with conditional requests, the declared tier, then store and index.

import type { Command } from "commander";
import { OpenKaError, StoreError, UsageError } from "@maschinenlesbar.org/openka-lib-errors";
import { HostPacer } from "@maschinenlesbar.org/openka-lib-http";
import {
  SYNC_LIMIT_MIN,
  planSync,
  syncSources,
  type ProgressEvent,
  type SourceOutcome,
  type SyncPlan,
  type SyncReport,
} from "@maschinenlesbar.org/openka-lib-pipeline";
import { PERIOD_RANGE } from "@maschinenlesbar.org/openka-lib-models";
import { OCR_MODES, createPerceiver, type OcrMode } from "@maschinenlesbar.org/openka-lib-perceive";
import { adapterSourceKeys, createSource, sourceKeyProblem, sourceKeys } from "@maschinenlesbar.org/openka-lib-registry";
import { FileStore, checkCorpusVolumes, lockCorpus, spaceGuard, type SpaceGuard, type Store } from "@maschinenlesbar.org/openka-lib-store";
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
  problemParser,
  toEngineOptions,
  volumeOptionsFrom,
} from "../shared.js";
import { formatBytes, formatCount, sanitizeForTerminal, truncate } from "../text.js";
import { SyncProgress } from "../progress.js";

/**
 * The most of one warning or error line that is printed. These are this program's own
 * sentences, often with an upstream reason or URL inside; at 200 characters the part
 * that explained them was cut ("… from the aggregator rather …"). The cap stays only
 * to bound upstream text.
 */
const MESSAGE_WIDTH = 2000;

type Source = ReturnType<typeof createSource>;

/** commander value-parser: a source key the registry knows — the library's `sourceKeyProblem`. */
const parseSourceKey = problemParser(sourceKeyProblem);

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
      "--source <key>",
      `source to sync, repeatable: several run side by side under one corpus lock (${sourceKeys().join(", ")})`,
      collectSourceKey,
    )
    .option("--all", "every source with an adapter of its own (not the parlamentsspiegel aggregator)")
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
    .option("--json", "print the sync report as JSON (an array of reports for several sources or --all)");
  addVolumeOptions(command)
    .action(
      action(deps, async (ctx) => {
        const io = ctx.deps.io;
        const named = ctx.opts["source"] as string[] | undefined;
        const all = ctx.opts["all"] === true;
        if (named === undefined && !all) throw new UsageError("Name a source with --source <key>, or sync every one with --all.");
        if (named !== undefined && all) throw new UsageError("--all already names every source; leave out --source.");

        const flagKey = ctx.opts["apiKey"] as string | undefined;
        const keyFor = (source: Source): string | undefined =>
          source.apiKeyEnv === undefined ? undefined : (flagKey ?? nonBlank(ctx.deps.env[source.apiKeyEnv]));
        let sources = (named ?? adapterSourceKeys()).map((key) => createSource(key));
        if (all) {
          // Named on its own, a source without its credential is an error, as it
          // always was. Under --all it is one of many, and failing the whole run
          // for the one source the user never asked for by name would make --all
          // unusable without a DIP key.
          for (const source of sources.filter((s) => s.apiKeyEnv !== undefined && keyFor(s) === undefined)) {
            io.err(`Note: skipped ${source.key}: it needs a credential (--api-key or ${source.apiKeyEnv}).`);
          }
          sources = sources.filter((s) => s.apiKeyEnv === undefined || keyFor(s) !== undefined);
        }
        const several = all || sources.length > 1;
        const store = ctx.store();
        if (ctx.opts["dryRun"] === true) {
          await dryRun(ctx, sources, store, keyFor, several);
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
        try {
          // The command takes the corpus lock itself — syncSources() re-enters it —
          // so that it can wait for it (--wait) and, before the first request, knows
          // what kind of volume the corpus is on.
          const purpose = `sync --source ${sources.map((source) => source.key).join(" --source ")}`;
          let release: () => void;
          try {
            release = await lockCorpus(store, purpose, {
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
            // One pacing book for every source's engine: two sources reaching one
            // host are paced together, so running them side by side never asks a
            // host for more than one source would. Each engine is its own, since a
            // source's politeness floor raises its engine's interval for good.
            const pacer = new HostPacer();
            outcomes = await syncSources({
              sources,
              store,
              engineFor: () => ctx.deps.createEngine({ ...toEngineOptions(ctx.global), pacer }),
              apiKeyFor: keyFor,
              perceiver,
              now: ctx.deps.now,
              signal: controller.signal,
              ...(ctx.opts["since"] === undefined ? {} : { since: ctx.opts["since"] as string }),
              ...(ctx.opts["until"] === undefined ? {} : { until: ctx.opts["until"] as string }),
              ...(ctx.opts["period"] === undefined ? {} : { period: ctx.opts["period"] as number }),
              ...(ctx.opts["limit"] === undefined ? {} : { limit: ctx.opts["limit"] as number }),
              ...(ctx.opts["metadataOnly"] === true ? { metadataOnly: true } : {}),
              ...(ctx.opts["force"] === true ? { force: true } : {}),
              ...(ctx.opts["ignoreRobots"] === true ? { ignoreRobots: true } : {}),
              ...(space === undefined ? {} : { space }),
              // Progress is stderr, so --json (which shapes stdout) keeps it.
              ...(progress === undefined
                ? {}
                : {
                    onStart: (source: string) => progress.start(source),
                    onDiscovered: (source: string, count: number) => progress.discovered(source, count),
                    onProgress: (source: string, event: ProgressEvent) => progress.update(source, event),
                    onDone: (outcome: SourceOutcome) => progress.finish(outcome.source),
                  }),
            });
          } finally {
            release();
          }
        } finally {
          progress?.close();
          stopListening?.();
        }

        const failed = outcomes.filter((outcome) => outcome.status === "failed");
        const done = outcomes.flatMap((outcome) => (outcome.status === "done" ? [outcome.report] : []));
        // A single source keeps the shape it always had: its report, and the error
        // it threw as the command's own.
        if (!several && failed[0] !== undefined) throw failed[0].error;

        const interrupted = done.filter((report) => report.interrupted);
        const stopped =
          caught !== undefined && (interrupted.length > 0 || outcomes.some((outcome) => outcome.status === "skipped"))
            ? new InterruptedRunError(
                caught,
                interrupted
                  .map((report) => `${report.source}: stopped after ${report.stored + report.unchanged + report.failed} of ${report.discovered} Anfragen`)
                  .concat(outcomes.filter((outcome) => outcome.status === "skipped").map((outcome) => `${outcome.source}: not started`))
                  .join("; ") + "; what was stored is catalogued. Run the same sync again to continue.",
              )
            : undefined;

        if (ctx.opts["json"] === true) {
          printJson(ctx, several ? outcomes.map(outcomeJson) : done[0]);
        } else {
          for (const report of done) printReport(io, report, several ? `${report.source}: ` : "");
        }
        for (const outcome of failed.slice(1)) {
          io.err(`error: ${outcome.source}: ${truncate(errorMessage(outcome.error), MESSAGE_WIDTH)}`);
        }
        if (stopped !== undefined) throw stopped;
        const low = done.filter((report) => report.lowSpace !== undefined);
        if (low.length > 0) {
          throw new StoreError(
            low
              .map((report) => `${report.source}: stopped after ${report.stored + report.unchanged + report.failed} of ${report.discovered} Anfragen — ${report.lowSpace}`)
              .join("; ") + "; what was stored is catalogued. Free some space, then run the same sync again to continue.",
          );
        }
        if (failed[0] !== undefined) {
          if (several) io.err(`error: ${failed[0].source} failed:`);
          throw failed[0].error;
        }
        const empty = done.filter((report) => report.errors.length > 0 && report.stored === 0).map((report) => report.source);
        if (empty.length > 0) throw new OpenKaError(`${empty.join(", ")}: sync produced no records`);
      }),
    );
}

/**
 * `ka sync --dry-run`: what each source's window holds and what a sync would
 * download (`planSync`). No lock, since nothing is written; one source after the
 * other, on one pacing book like a real run.
 */
async function dryRun(
  ctx: ActionContext,
  sources: Source[],
  store: Store,
  keyFor: (source: Source) => string | undefined,
  several: boolean,
): Promise<void> {
  const io = ctx.deps.io;
  const pacer = new HostPacer();
  const results: { source: string; plan?: SyncPlan; error?: unknown }[] = [];
  for (const source of sources) {
    if (ctx.global.quiet !== true) io.err(`${source.key}: discovering (no document is downloaded)…`);
    const apiKey = keyFor(source);
    try {
      const plan = await planSync({
        source,
        store,
        engine: ctx.deps.createEngine({ ...toEngineOptions(ctx.global), pacer }),
        ...(ctx.opts["since"] === undefined ? {} : { since: ctx.opts["since"] as string }),
        ...(ctx.opts["until"] === undefined ? {} : { until: ctx.opts["until"] as string }),
        ...(ctx.opts["period"] === undefined ? {} : { period: ctx.opts["period"] as number }),
        ...(ctx.opts["limit"] === undefined ? {} : { limit: ctx.opts["limit"] as number }),
        ...(apiKey === undefined ? {} : { apiKey }),
        ...(ctx.opts["metadataOnly"] === true ? { metadataOnly: true } : {}),
        ...(ctx.opts["ignoreRobots"] === true ? { ignoreRobots: true } : {}),
      });
      results.push({ source: source.key, plan });
    } catch (error) {
      if (!several) throw error;
      results.push({ source: source.key, error });
    }
  }
  if (ctx.opts["json"] === true) {
    const json = results.map((result) => result.plan ?? { source: result.source, error: errorMessage(result.error) });
    printJson(ctx, several ? json : json[0]);
  } else {
    for (const result of results) {
      if (result.plan === undefined) continue;
      const plan = result.plan;
      if (plan.blocked !== undefined) {
        io.out(`${plan.source} ${windowLabel(plan.window)}: blocked — nothing was looked at (see the warning)`);
      } else {
        io.out(
          `${plan.source} ${windowLabel(plan.window)}: ${formatCount(plan.discovered)} Anfragen discovered, ` +
            `${formatCount(plan.in_corpus)} already in corpus`,
        );
        io.out(`${several ? `${plan.source}: ` : ""}documents to fetch: ${fetchLabel(plan, ctx.opts["metadataOnly"] === true)}`);
      }
      for (const warning of plan.warnings) io.err(`warning: ${several ? `${plan.source}: ` : ""}${truncate(warning, MESSAGE_WIDTH)}`);
    }
  }
  if (store instanceof FileStore) dryRunSpace(ctx, store, results.flatMap((result) => (result.plan === undefined ? [] : [result.plan])));
  const failed = results.filter((result) => result.error !== undefined);
  for (const result of failed.slice(1)) io.err(`error: ${result.source}: ${truncate(errorMessage(result.error), MESSAGE_WIDTH)}`);
  if (failed[0] !== undefined) {
    io.err(`error: ${failed[0].source} failed:`);
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

/** commander accumulator for a repeatable `--source`: each a key the registry knows. */
function collectSourceKey(value: string, previous: string[] = []): string[] {
  return previous.concat([parseSourceKey(value)]);
}

function nonBlank(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One source's outcome in `--json` output for several sources. */
function outcomeJson(outcome: SourceOutcome): unknown {
  if (outcome.status === "done") return outcome.report;
  if (outcome.status === "skipped") return { source: outcome.source, skipped: true };
  return { source: outcome.source, error: errorMessage(outcome.error) };
}

/** The text summary of one report; `prefix` names the source when several ran. */
function printReport(io: CliIO, report: SyncReport, prefix: string): void {
  if (report.upstreamUnchanged) {
    io.out(`${report.source}: upstream reports no change since the last sync — nothing to do.`);
    return;
  }
  if (report.blocked !== undefined) {
    // Not "0 discovered": nothing was looked at, and a cron job reading this must not
    // take it for a quiet day.
    io.out(`${report.source}: blocked — nothing was looked at, and the run is not recorded as a sync (see the warning)`);
    for (const warning of report.warnings) io.err(`warning: ${prefix}${truncate(warning, MESSAGE_WIDTH)}`);
    return;
  }
  io.out(
    `${report.source}: ${report.discovered} discovered, ${report.stored} stored, ` +
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
