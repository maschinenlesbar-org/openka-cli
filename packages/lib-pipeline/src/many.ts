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

import { OpenKaError, assertValid, type Problem } from "@maschinenlesbar.org/openka-lib-errors";
import type { FetchEngine } from "@maschinenlesbar.org/openka-lib-http";
import { RobotsPolicy, type Source } from "@maschinenlesbar.org/openka-lib-source";
import { withCorpusLock } from "@maschinenlesbar.org/openka-lib-store";
import { DocumentMemo, sync, type ProgressEvent, type SyncOptions, type SyncReport } from "./index.js";
import { normalizeSyncWindow } from "./window.js";

export interface SyncSourcesOptions
  extends Omit<SyncOptions, "source" | "engine" | "apiKey" | "onDiscovered" | "onProgress"> {
  /** The sources to run, each at most once; outcomes come back in this order. */
  sources: readonly Source[];
  /**
   * The engine for one source — a new one per source, best built on one shared
   * `HostPacer` (`EngineOptions.pacer`), so a host two sources reach is paced once.
   */
  engineFor: (source: Source) => FetchEngine;
  /** The credential for a source that takes one (`Source.apiKeyEnv`), if any. */
  apiKeyFor?: (source: Source) => string | undefined;
  /** A source is about to start. */
  onStart?: (source: string) => void;
  onDiscovered?: (source: string, count: number) => void;
  onProgress?: (source: string, event: ProgressEvent) => void;
  /** A source has finished, failed or been skipped. */
  onDone?: (outcome: SourceOutcome) => void;
}

/** What became of one source: its report, the error it threw, or not started at all. */
export type SourceOutcome =
  | { source: string; status: "done"; report: SyncReport }
  | { source: string; status: "failed"; error: unknown }
  /** `signal` was aborted before the source's turn came. */
  | { source: string; status: "skipped" };

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

/**
 * The order sources run in: `concurrent` lanes run side by side, each lane's
 * sources one after another; `after` runs alone once every lane is done. Sources of
 * one parliament share a lane; a source tied to none (an aggregator) goes `after`.
 */
export function planLanes<S extends Pick<Source, "key" | "parliament">>(sources: readonly S[]): { concurrent: S[][]; after: S[] } {
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
 * Sync several sources in one run, under one corpus lock, concurrently where that
 * is safe (`planLanes`). The window (`since`, `until`, `period`, `limit`) applies to
 * every source and is checked once, before the lock is taken or anything is asked.
 *
 * One source failing does not stop the others: its error is its outcome
 * (`status: "failed"`), and the caller decides what the run as a whole exits with.
 * An aborted `signal` stops each running source between two refs, as in `sync()`,
 * and the sources whose turn had not come are `skipped`.
 */
export async function syncSources(options: SyncSourcesOptions): Promise<SourceOutcome[]> {
  assertValid("sources", options.sources, sourceListProblem);
  normalizeSyncWindow(options);
  const { sources, engineFor, apiKeyFor, onStart, onDiscovered, onProgress, onDone, ...shared } = options;
  const purpose = `sync --source ${sources.map((source) => source.key).join(" --source ")}`;
  return withCorpusLock(options.store, purpose, async () => {
    const outcomes = new Map<string, SourceOutcome>();
    // One reading of each host's robots.txt and one download of each document for
    // the whole run, whichever source reaches them first. The policy fetches with an
    // engine of its own; its slow-downs land on the pacer every engine shares.
    const first = sources[0] as Source;
    const robots = shared.robots ?? new RobotsPolicy(engineFor(first), shared.ignoreRobots === true);
    const documents = shared.documents ?? new DocumentMemo();
    const runOne = async (source: Source): Promise<void> => {
      let outcome: SourceOutcome;
      if (options.signal?.aborted === true) {
        outcome = { source: source.key, status: "skipped" };
      } else {
        onStart?.(source.key);
        try {
          const apiKey = apiKeyFor?.(source);
          const report = await sync({
            ...shared,
            robots,
            documents,
            source,
            engine: engineFor(source),
            ...(apiKey === undefined ? {} : { apiKey }),
            ...(onDiscovered === undefined ? {} : { onDiscovered: (count: number) => onDiscovered(source.key, count) }),
            ...(onProgress === undefined ? {} : { onProgress: (event: ProgressEvent) => onProgress(source.key, event) }),
          });
          outcome = { source: source.key, status: "done", report };
        } catch (error) {
          outcome = { source: source.key, status: "failed", error };
        }
      }
      outcomes.set(source.key, outcome);
      onDone?.(outcome);
    };
    const { concurrent, after } = planLanes(sources);
    await Promise.all(
      concurrent.map(async (lane) => {
        for (const source of lane) await runOne(source);
      }),
    );
    for (const source of after) await runOne(source);
    return sources.map((source) => {
      const outcome = outcomes.get(source.key);
      if (outcome === undefined) throw new OpenKaError(`internal: ${source.key} was never run`);
      return outcome;
    });
  });
}
