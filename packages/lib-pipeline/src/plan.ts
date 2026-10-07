// What a sync would do, without doing it: `ka sync --dry-run`.
//
// Before a big sync there was no way to learn how many Anfragen a window holds or how
// much disk their documents take — and on a 116 GB USB stick that decides whether a
// collection fits (issue #6). This runs discovery only: no document is downloaded,
// nothing is written, and the corpus lock is not taken. What it reports:
//
// - how many Anfragen the window holds, and how many of them the corpus has already;
// - how many documents a sync would download — every document URL whose bytes the
//   corpus does not hold under a validator, once each (Berlin puts question and
//   answer in one PDF);
// - an estimate of their size: the average of the documents the corpus already holds
//   for this source when it holds at least `ESTIMATE_MIN_KNOWN`, otherwise the
//   `Content-Length` of a HEAD sample of up to `DRY_RUN_SAMPLE` of the documents to
//   fetch. A HEAD goes through the same robots.txt check and the same pacing as a
//   real fetch.

import type { FetchEngine } from "@maschinenlesbar.org/openka-lib-http";
import { makeRecordId, referenceSlug } from "@maschinenlesbar.org/openka-lib-models";
import { RobotsPolicy, type DocRef, type Source } from "@maschinenlesbar.org/openka-lib-source";
import type { Store } from "@maschinenlesbar.org/openka-lib-store";
import { statSync } from "node:fs";
import { normalizeSyncWindow, type SyncWindow } from "./window.js";

/** The most documents a dry run asks for with HEAD to estimate their size. */
export const DRY_RUN_SAMPLE = 20;

/** How many archived documents of a source make their average a usable estimate. */
export const ESTIMATE_MIN_KNOWN = 20;

export interface SyncPlanOptions extends SyncWindow {
  source: Source;
  /** Read only: records, blobs and source state. Nothing is written. */
  store: Pick<Store, "getSourceState" | "hasRecord" | "hasBlob" | "blobPath" | "loadArtifact" | "assertBlobStore">;
  engine: FetchEngine;
  apiKey?: string;
  metadataOnly?: boolean;
  ignoreRobots?: boolean;
  /** HEAD requests at most for the size estimate (default `DRY_RUN_SAMPLE`); 0 asks none. */
  sample?: number;
}

export interface SizeEstimate {
  /** Average document size the estimate rests on, in bytes. */
  average_bytes: number;
  /** `average_bytes` times the documents to fetch. */
  total_bytes: number;
  /** Where the average comes from. */
  basis: "corpus" | "head-sample";
  /** How many documents the average was taken over. */
  sampled: number;
}

export interface SyncPlan {
  source: string;
  window: SyncWindow;
  /** Anfragen discovery found in the window. */
  discovered: number;
  /** Of those, the ones whose record the corpus holds already. */
  in_corpus: number;
  /** Document downloads a sync would make: URLs whose bytes the corpus does not hold. */
  documents_to_fetch: number;
  /** Absent when nothing is to be fetched or nothing could be measured. */
  estimate?: SizeEstimate;
  warnings: string[];
}

/**
 * Discover what a sync over this window would handle, and estimate what it would
 * download, without downloading a document or writing anything. The window is
 * checked as `sync()` checks it, and the source's politeness floor is applied to the
 * engine the same way.
 */
export async function planSync(options: SyncPlanOptions): Promise<SyncPlan> {
  const window = normalizeSyncWindow({
    ...(options.since === undefined ? {} : { since: options.since }),
    ...(options.until === undefined ? {} : { until: options.until }),
    ...(options.period === undefined ? {} : { period: options.period }),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  });
  const { source, store, engine } = options;
  // Which documents the corpus holds is read from the blob store; with it unplugged,
  // every one would count as still to fetch.
  store.assertBlobStore?.();
  if (source.minHostIntervalMs !== undefined) engine.raiseMinHostInterval(source.minHostIntervalMs);
  const state = store.getSourceState(source.key);

  // `force` bypasses the feed's own validators: a feed unchanged since the last sync
  // answers 304 and an empty list, which is no answer to "what does this window hold".
  // One robots.txt reading per host for the plan, shared by the connector's gate and
  // the HEAD sample.
  const robots = new RobotsPolicy(engine, options.ignoreRobots === true);
  const discovered = await source.discover({
    engine,
    store,
    state,
    ...window,
    force: true,
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    ...(options.ignoreRobots === true ? { ignoreRobots: true } : {}),
    robots,
  });

  const plan: SyncPlan = {
    source: source.key,
    window,
    discovered: discovered.refs.length,
    in_corpus: 0,
    documents_to_fetch: 0,
    warnings: [...discovered.warnings],
  };
  for (const ref of discovered.refs) if (isInCorpus(ref, source, store)) plan.in_corpus++;
  if (options.metadataOnly === true) return plan;

  const cache = state.http_cache;
  const held = (url: string): boolean => {
    const digest = cache[url]?.sha256;
    return digest !== undefined && store.hasBlob(digest);
  };
  const toFetch = [...new Set(discovered.refs.flatMap((ref) => ref.documents.map((document) => document.url)))].filter(
    (url) => !held(url),
  );
  plan.documents_to_fetch = toFetch.length;
  if (toFetch.length === 0) return plan;

  const known = knownSizes(store, Object.values(cache).map((entry) => entry.sha256));
  if (known.length >= ESTIMATE_MIN_KNOWN) {
    plan.estimate = estimate(known, toFetch.length, "corpus");
    return plan;
  }
  const sampled = await headSample(engine, evenSample(toFetch, options.sample ?? DRY_RUN_SAMPLE), robots, plan.warnings);
  const sizes = sampled.length > 0 ? sampled : known;
  if (sizes.length > 0) plan.estimate = estimate(sizes, toFetch.length, sampled.length > 0 ? "head-sample" : "corpus");
  return plan;
}

function isInCorpus(ref: DocRef, source: Source, store: Pick<Store, "hasRecord">): boolean {
  const parliament = ref.parliament ?? source.parliament;
  if (parliament === undefined || referenceSlug(ref.reference) === "") return false;
  return store.hasRecord(makeRecordId(parliament, ref.legislative_period, ref.reference));
}

/** Sizes of the archived documents among `digests` — what this source already brought in. */
function knownSizes(store: Pick<Store, "hasBlob" | "blobPath">, digests: (string | undefined)[]): number[] {
  const sizes: number[] = [];
  for (const digest of new Set(digests)) {
    if (digest === undefined || !store.hasBlob(digest)) continue;
    try {
      sizes.push(statSync(store.blobPath(digest)).size);
    } catch {
      // A store without files on disk (the in-memory double) has no sizes to give.
    }
  }
  return sizes;
}

/** Up to `n` items spread evenly over `items`, first and last included — not just the newest. */
function evenSample<T>(items: readonly T[], n: number): T[] {
  if (n <= 0 || items.length === 0) return [];
  if (items.length <= n) return [...items];
  const step = (items.length - 1) / Math.max(1, n - 1);
  return Array.from({ length: n }, (_, i) => items[Math.round(i * step)] as T);
}

async function headSample(engine: FetchEngine, urls: string[], robots: RobotsPolicy, warnings: string[]): Promise<number[]> {
  const sizes: number[] = [];
  let refused = 0;
  for (const url of urls) {
    const verdict = await robots.decide(url);
    if (!verdict.allowed) {
      refused++;
      continue;
    }
    try {
      let hopRefused = false;
      const response = await engine.head(url, {
        onRedirect: async (next) => {
          if (!(await robots.decide(next)).allowed) {
            hopRefused = true;
            throw new Error(`redirect to ${next} is disallowed by its host's robots.txt`);
          }
        },
      }).catch((err: unknown) => {
        if (hopRefused) return undefined;
        throw err;
      });
      if (response === undefined) {
        refused++;
        continue;
      }
      const length = Number(firstHeader(response.headers["content-length"]));
      if (response.status === 200 && Number.isSafeInteger(length) && length > 0) sizes.push(length);
    } catch {
      // A failed HEAD is a sample not taken, not a failed plan.
    }
  }
  if (refused > 0) warnings.push(`${refused} of ${urls.length} sampled document(s) are disallowed by robots.txt and were not asked for`);
  return sizes;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function estimate(sizes: number[], documents: number, basis: SizeEstimate["basis"]): SizeEstimate {
  const average = Math.round(sizes.reduce((sum, size) => sum + size, 0) / sizes.length);
  return { average_bytes: average, total_bytes: average * documents, basis, sampled: sizes.length };
}
