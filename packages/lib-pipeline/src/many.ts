// Several sources in one run: one process, one corpus lock, sources side by side.
//
// The corpus lock admits one writer, which is right — and meant that a Berlin sync
// and a Bundestag sync, which reach different hosts and are each paced on their own,
// could not run at the same time. The second one exited 3, so people queued them
// with a shell loop polling `pgrep` (issue #3). This runs them in one process under
// one lock instead.
//
// What keeps that safe:
//
// - **Each source gets its own engine** (`engineFor`), because `sync()` raises an
//   engine's interval to the source's politeness floor and never lowers it —
//   Brandenburg's 4 s would otherwise slow every other source down. The engines
//   should share one `HostPacer`: then two sources that reach the same host (every
//   Land discovered through the Parlamentsspiegel does) are paced together, and the
//   host sees no more requests than one source would send.
// - **Two sources that file records under the same parliament never run at once.**
//   A record is read before its documents are fetched and written after; two runs
//   writing one record id in between would index one against the other's stale
//   copy. Sources pinned to one parliament share a lane with any other source of
//   that parliament, and run concurrently with the other lanes. An aggregator,
//   which files under several (`parlamentsspiegel`), runs alone, after them.
// - **Catalog batches of concurrent runs each flush at their own end**
//   (`FileStore.batchCatalog`), so the checkpoint promise of `sync()` still holds.
//
// The unit is a job (`syncJobs`): a source over a window of its own, so one run can
// take Berlin 2025 beside the Bundestag 2026, or the Bundestag one Wahlperiode after
// the other (issue #17). Two jobs of one source share its parliament's lane and run
// in the order given. `syncSources` is the jobs of several sources over one window.

import { OpenKaError, assertValid, type Problem } from "@maschinenlesbar.org/openka-lib-errors";
import type { FetchEngine } from "@maschinenlesbar.org/openka-lib-http";
import { RobotsPolicy, type Source } from "@maschinenlesbar.org/openka-lib-source";
import { withCorpusLock } from "@maschinenlesbar.org/openka-lib-store";
import { DocumentMemo, sync, type ProgressEvent, type SyncOptions, type SyncReport } from "./index.js";
import { normalizeSyncWindow, type SyncWindow } from "./window.js";
import { windowOf } from "./jobs.js";

/** One job of a run: a source over its own window, named by `label` (`jobLabel`). */
export interface SyncJob {
  label: string;
  source: Source;
  window?: SyncWindow;
}

type SharedSyncOptions = Omit<SyncOptions, "source" | "engine" | "apiKey" | "onDiscovered" | "onProgress" | keyof SyncWindow>;

export interface SyncJobsOptions extends SharedSyncOptions {
  /** The jobs to run, no label twice; outcomes come back in this order. */
  jobs: readonly SyncJob[];
  /**
   * The engine for one job — a new one per job, best built on one shared
   * `HostPacer` (`EngineOptions.pacer`), so a host two jobs reach is paced once.
   */
  engineFor: (source: Source) => FetchEngine;
  /** The credential for a source that takes one (`Source.apiKeyEnv`), if any. */
  apiKeyFor?: (source: Source) => string | undefined;
  /** Start no job once one has failed: the rest are `skipped` (`reason: "after-failure"`). Default false. */
  stopOnFailure?: boolean;
  /** A job is about to start; the callbacks name it by its label. */
  onStart?: (job: string) => void;
  onDiscovered?: (job: string, count: number) => void;
  onProgress?: (job: string, event: ProgressEvent) => void;
  /** A job has finished, failed or been skipped. */
  onDone?: (outcome: SourceOutcome) => void;
}

export interface SyncSourcesOptions extends Omit<SyncJobsOptions, "jobs">, SyncWindow {
  /** The sources to run, each at most once, all over the one window; outcomes come back in this order. */
  sources: readonly Source[];
}

/**
 * What became of one job: its report, the error it threw, or not started at all.
 * `job` is its label — the source key for a job without a window of its own.
 */
export type SourceOutcome =
  | { job: string; source: string; status: "done"; report: SyncReport }
  | { job: string; source: string; status: "failed"; error: unknown }
  /**
   * Not started: `signal` was aborted before its turn came (`interrupted`), or an
   * earlier job failed under `stopOnFailure` (`after-failure`).
   */
  | { job: string; source: string; status: "skipped"; reason: "interrupted" | "after-failure" };

/** A list of sources to sync: at least one, none twice. */
export const sourceListProblem: Problem<readonly Source[]> = (sources) => {
  if (sources.length === 0) return "Name at least one source.";
  const seen = new Set<string>();
  for (const source of sources) {
    if (seen.has(source.key)) return `"${source.key}" is named twice.`;
    seen.add(source.key);
  }
  return undefined;
};

/** A list of jobs: at least one, no label twice — one source over two windows is two jobs. */
export const jobListProblem: Problem<readonly SyncJob[]> = (jobs) => {
  if (jobs.length === 0) return "Name at least one source.";
  const seen = new Set<string>();
  for (const job of jobs) {
    if (seen.has(job.label)) return `"${job.label}" is named twice.`;
    seen.add(job.label);
  }
  return undefined;
};

/**
 * The order sources run in: `concurrent` lanes run side by side, each lane's
 * sources one after another; `after` runs alone once every lane is done. Sources of
 * one parliament share a lane; a source tied to none (an aggregator) goes `after`.
 */
export function planLanes<S extends Pick<Source, "parliament">>(sources: readonly S[]): { concurrent: S[][]; after: S[] } {
  const lanes = new Map<string, S[]>();
  const after: S[] = [];
  for (const source of sources) {
    if (source.parliament === undefined) {
      after.push(source);
      continue;
    }
    const lane = lanes.get(source.parliament) ?? [];
    lane.push(source);
    lanes.set(source.parliament, lane);
  }
  return { concurrent: [...lanes.values()], after };
}

/**
 * Sync several sources over one window in one run — `syncJobs` with one job per
 * source, labelled by its key. The sources are checked first (`sourceListProblem`):
 * none twice.
 */
export async function syncSources(options: SyncSourcesOptions): Promise<SourceOutcome[]> {
  assertValid("sources", options.sources, sourceListProblem);
  const { sources, since: _since, until: _until, period: _period, limit: _limit, refs: _refs, retryFailed: _retry, onlyNew: _onlyNew, ...rest } = options;
  const window = normalizeSyncWindow(windowOf(options));
  return syncJobs({ ...rest, jobs: sources.map((source) => ({ label: source.key, source, window })) });
}

/**
 * Run sync jobs in one run, under one corpus lock, concurrently where that is safe
 * (`planLanes` on the jobs' parliaments). Every job's window is checked once, before
 * the lock is taken or anything is asked, and no label may come twice
 * (`jobListProblem`).
 *
 * One job failing does not stop the others, unless `stopOnFailure`: its error is its
 * outcome (`status: "failed"`), and the caller decides what the run as a whole exits
 * with. An aborted `signal` stops each running job between two refs, as in `sync()`,
 * and the jobs whose turn had not come are `skipped`.
 */
export async function syncJobs(options: SyncJobsOptions): Promise<SourceOutcome[]> {
  assertValid("sources", options.jobs, jobListProblem);
  const jobs = options.jobs.map((job) => ({ ...job, window: normalizeSyncWindow(job.window ?? {}) }));
  const { engineFor, apiKeyFor, onStart, onDiscovered, onProgress, onDone, stopOnFailure, jobs: _jobs, ...shared } = options;
  const purpose = `sync ${jobs.map((job) => `--source ${job.label}`).join(" ")}`;
  return withCorpusLock(options.store, purpose, async () => {
    const outcomes = new Map<string, SourceOutcome>();
    let failedOnce = false;
    // One reading of each host's robots.txt and one download of each document for
    // the whole run, whichever job reaches them first. The policy fetches with an
    // engine of its own; its slow-downs land on the pacer every engine shares.
    const first = (jobs[0] as SyncJob).source;
    const robots = shared.robots ?? new RobotsPolicy(engineFor(first), shared.ignoreRobots === true);
    const documents = shared.documents ?? new DocumentMemo();
    const runOne = async (job: SyncJob & { window: SyncWindow }): Promise<void> => {
      let outcome: SourceOutcome;
      const ids = { job: job.label, source: job.source.key };
      if (options.signal?.aborted === true) {
        outcome = { ...ids, status: "skipped", reason: "interrupted" };
      } else if (stopOnFailure === true && failedOnce) {
        outcome = { ...ids, status: "skipped", reason: "after-failure" };
      } else {
        onStart?.(job.label);
        try {
          const apiKey = apiKeyFor?.(job.source);
          const report = await sync({
            ...shared,
            ...job.window,
            robots,
            documents,
            source: job.source,
            engine: engineFor(job.source),
            ...(apiKey === undefined ? {} : { apiKey }),
            ...(onDiscovered === undefined ? {} : { onDiscovered: (count: number) => onDiscovered(job.label, count) }),
            ...(onProgress === undefined ? {} : { onProgress: (event: ProgressEvent) => onProgress(job.label, event) }),
          });
          outcome = { ...ids, status: "done", report };
        } catch (error) {
          failedOnce = true;
          outcome = { ...ids, status: "failed", error };
        }
      }
      outcomes.set(job.label, outcome);
      onDone?.(outcome);
    };
    const { concurrent, after } = planLanes(jobs.map((job) => ({ job, parliament: job.source.parliament })));
    await Promise.all(
      concurrent.map(async (lane) => {
        for (const { job } of lane) await runOne(job);
      }),
    );
    for (const { job } of after) await runOne(job);
    return jobs.map((job) => {
      const outcome = outcomes.get(job.label);
      if (outcome === undefined) throw new OpenKaError(`internal: ${job.label} was never run`);
      return outcome;
    });
  });
}
