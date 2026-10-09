// `ka sync`'s progress line.
//
// A real run (Berlin 2026: 2,471 Anfragen, about 170 MB) was silent on stderr for
// over an hour, and the only way to tell it from a hung one was `ls records | wc -l`
// (issue #2). The line says where each source stands:
//
//   berlin: 1220/2471 · 0 failed · 4.1/min · ~5h 05m left
//
// On a terminal it is redrawn in place, one line for every source running, and is not
// a log record: it is the one thing on stderr that is redrawn rather than added to.
// Anywhere else — a log file, a pipe, cron — it is an INFO record of `ka.sync`
// (`log.ts`), at most every `EVERY_REFS` Anfragen or `EVERY_MS` per source, so a log
// stays readable and grep-able. A failed Anfrage is a WARN record either way; on a
// terminal it is printed above the redrawn line, which is drawn again below it.
//
// It goes to stderr, so `--json` (which shapes stdout) leaves it on; `--quiet` is
// the switch that silences it. Time comes from `CliDeps.now`, the CLI's one clock.

import type { ProgressEvent, SyncTiming } from "@maschinenlesbar.org/openka-lib-pipeline";
import { logOf, type CliIO } from "./io.js";
import type { Logger } from "./log.js";
import { truncate } from "./text.js";

/** A plain progress line at most every this many Anfragen per source… */
export const EVERY_REFS = 25;
/** …or once this much time has passed since the last one. */
export const EVERY_MS = 30_000;
/**
 * The rate and the time left are taken over this much of the recent past, not since
 * the start: a Berlin run whose upstream halved its pace kept saying "~31 min left"
 * for half an hour (issue #14).
 */
export const RECENT_MS = 10 * 60_000;
/** A recent rate this far from the average is shown beside it ("7/min now (10/min avg)"). */
const RATE_DRIFT = 0.15;

interface SourceProgress {
  total: number | undefined;
  done: number;
  failed: number;
  /** When discovery finished: the rate is measured from there, not from the start. */
  startedAt: number | undefined;
  lastPrinted: { done: number; at: number } | undefined;
  /** `[at, done]` of the last `RECENT_MS`, the first one just before it — for the recent rate. */
  samples: [number, number][];
  timing: SyncTiming | undefined;
}

export class SyncProgress {
  private readonly sources = new Map<string, SourceProgress>();
  /** Whether a redrawn status line is on the terminal and must be cleared before other output. */
  private drawn = false;

  private readonly log: Logger;

  constructor(
    private readonly io: CliIO,
    private readonly now: () => Date,
    /** Where the records go; unset, text records through `io.err`. */
    log?: Logger,
  ) {
    this.log = log ?? logOf({ io, now });
  }

  /** Register a source before it starts, so a terminal line shows it while it discovers. */
  start(source: string): void {
    this.sources.set(source, fresh());
    this.redraw();
  }

  discovered(source: string, total: number): void {
    const state = this.state(source);
    state.total = total;
    state.startedAt = this.now().getTime();
    state.samples = [[state.startedAt, 0]];
    if (this.terminal()) this.redraw();
    else if (total > 0) this.log.info("sync", `${source}: ${total} Anfragen discovered`);
  }

  update(source: string, event: ProgressEvent): void {
    const state = this.state(source);
    state.done = event.index;
    state.total = event.total;
    if (event.timing !== undefined) state.timing = event.timing;
    const at = this.now().getTime();
    state.samples.push([at, event.index]);
    while (state.samples.length > 2 && at - (state.samples[1] as [number, number])[0] > RECENT_MS) state.samples.shift();
    if (event.action === "failed") {
      state.failed++;
      this.above(() => this.log.warn("sync", `${source}: ${truncate(event.id, 40)} failed: ${truncate(event.detail ?? "failed", 100)}`));
    }
    if (this.terminal()) {
      this.redraw();
      return;
    }
    const last = state.lastPrinted;
    const due =
      event.index === event.total ||
      (last === undefined ? event.index >= EVERY_REFS : event.index - last.done >= EVERY_REFS || at - last.at >= EVERY_MS);
    if (due) {
      state.lastPrinted = { done: event.index, at };
      this.log.info("sync", this.describe(source, state));
    }
  }

  /** A source is done; its line leaves the redrawn status. */
  finish(source: string): void {
    const state = this.sources.get(source);
    if (state === undefined) return;
    this.sources.delete(source);
    if (this.terminal()) {
      // Leave the final count on screen, then redraw what is still running below it.
      this.clear();
      if (state.total !== undefined && state.total > 0) this.log.info("sync", this.describe(source, state));
      this.redraw();
    }
  }

  /**
   * Write what must stay — a log record — clearing a redrawn status line first and
   * drawing it again below. Off a terminal there is nothing to clear.
   */
  above(write: () => void): void {
    this.clear();
    write();
    this.redraw();
  }

  /** Clear the redrawn line for good: before the summary, or when the run ends. */
  close(): void {
    this.clear();
  }

  private terminal(): boolean {
    return this.io.errIsTerminal === true && this.io.errPartial !== undefined;
  }

  private state(source: string): SourceProgress {
    let state = this.sources.get(source);
    if (state === undefined) {
      state = fresh();
      this.sources.set(source, state);
    }
    return state;
  }

  private clear(): void {
    if (!this.drawn) return;
    this.io.errPartial?.("\r\u001b[K");
    this.drawn = false;
  }

  private redraw(): void {
    if (!this.terminal() || this.sources.size === 0) return;
    const parts = [...this.sources].map(([source, state]) => this.describe(source, state));
    this.io.errPartial?.(`\r\u001b[K${parts.join("  |  ")}`);
    this.drawn = true;
  }

  private describe(source: string, state: SourceProgress): string {
    if (state.total === undefined) return `${source}: discovering…`;
    const parts = [`${source}: ${state.done}/${state.total}`, `${state.failed} failed`];
    const now = this.now().getTime();
    const elapsedMs = state.startedAt === undefined ? 0 : now - state.startedAt;
    if (state.done > 0 && elapsedMs > 0) {
      const average = (state.done / elapsedMs) * 60_000;
      const recent = recentRate(state.samples) ?? average;
      // The time left follows the recent pace; the average stays beside it once the two part.
      const drifted = Math.abs(recent - average) > average * RATE_DRIFT;
      parts.push(drifted ? `${perMinute(recent)}/min now (${perMinute(average)}/min avg)` : `${perMinute(average)}/min`);
      const remaining = state.total - state.done;
      if (remaining === 0) parts.push(`done in ${duration(elapsedMs)}`);
      else if (recent > 0) parts.push(`~${duration((remaining / recent) * 60_000)} left`);
    }
    if (state.timing !== undefined) parts.push(...where(state.timing, state.done));
    return parts.join(" · ");
  }
}

function fresh(): SourceProgress {
  return { total: undefined, done: 0, failed: 0, startedAt: undefined, lastPrinted: undefined, samples: [], timing: undefined };
}

function perMinute(rate: number): string {
  return rate >= 10 ? String(Math.round(rate)) : rate.toFixed(1);
}

/** Anfragen per minute over the samples kept (the last `RECENT_MS`); undefined until they span time. */
function recentRate(samples: readonly [number, number][]): number | undefined {
  const first = samples[0];
  const last = samples.at(-1);
  if (first === undefined || last === undefined || last[0] <= first[0]) return undefined;
  return ((last[1] - first[1]) / (last[0] - first[0])) * 60_000;
}

/**
 * Where the time goes, in a few words: the average time a request takes upstream, the
 * share of the run spent waiting to be polite, extraction per Anfrage, and retries and
 * 429/503 answers when there were any — so "it is slow" reads as "the upstream is
 * slow", "it is throttling us" or "extraction is slow".
 */
function where(timing: SyncTiming, done: number): string[] {
  const parts: string[] = [];
  if (timing.upstreamMsAvg !== undefined) parts.push(`upstream ${seconds(timing.upstreamMsAvg)}/req`);
  if (timing.elapsedMs > 0 && timing.waitMs > 0) parts.push(`waiting ${Math.round((timing.waitMs / timing.elapsedMs) * 100)}%`);
  if (done > 0 && timing.extractMs > 0) parts.push(`extract ${seconds(timing.extractMs / done)}`);
  // Writing the index at each checkpoint grows with the corpus (issue #30); its share says when it matters.
  if (timing.elapsedMs > 0 && (timing.indexMs ?? 0) > 0) parts.push(`index ${Math.round(((timing.indexMs ?? 0) / timing.elapsedMs) * 100)}%`);
  if (timing.retries > 0) {
    // Why, so a run that retries without the server asking (issue #31) shows it.
    const reasons = (["throttled", "timeout", "connection", "other"] as const)
      .filter((reason) => (timing.retryReasons?.[reason] ?? 0) > 0)
      .map((reason) => `${timing.retryReasons?.[reason]} ${reason}`);
    parts.push(`retries ${timing.retries}${reasons.length === 0 ? "" : ` (${reasons.join(", ")})`}`);
  }
  if ((timing.reconnects ?? 0) > 0) parts.push(`reconnected ${timing.reconnects}`);
  if (timing.throttled > 0) parts.push(`throttled ${timing.throttled}×`);
  return parts;
}

function seconds(ms: number): string {
  return ms >= 10_000 ? `${Math.round(ms / 1000)} s` : `${(ms / 1000).toFixed(1)} s`;
}

/** A duration for people: "40s", "12 min", "5h 05m". */
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}
