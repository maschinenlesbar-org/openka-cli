// `ka sync`'s progress line.
//
// A real run (Berlin 2026: 2,471 Anfragen, about 170 MB) was silent on stderr for
// over an hour, and the only way to tell it from a hung one was `ls records | wc -l`
// (issue #2). The line says where each source stands:
//
//   berlin: 1220/2471 · 0 failed · 4.1/min · ~5h 05m left
//
// On a terminal it is redrawn in place, one line for every source running. Anywhere
// else — a log file, a pipe — it is a plain line, at most every `EVERY_REFS`
// Anfragen or `EVERY_MS` per source, so a log stays readable and grep-able.
//
// It goes to stderr, so `--json` (which shapes stdout) leaves it on; `--quiet` is
// the switch that silences it. Time comes from `CliDeps.now`, the CLI's one clock.

import type { ProgressEvent } from "@maschinenlesbar.org/openka-lib-pipeline";
import type { CliIO } from "./io.js";
import { truncate } from "./text.js";

/** A plain progress line at most every this many Anfragen per source… */
export const EVERY_REFS = 25;
/** …or once this much time has passed since the last one. */
export const EVERY_MS = 30_000;

interface SourceProgress {
  total: number | undefined;
  done: number;
  failed: number;
  /** When discovery finished: the rate is measured from there, not from the start. */
  startedAt: number | undefined;
  lastPrinted: { done: number; at: number } | undefined;
}

export class SyncProgress {
  private readonly sources = new Map<string, SourceProgress>();
  /** Whether a redrawn status line is on the terminal and must be cleared before other output. */
  private drawn = false;

  constructor(
    private readonly io: CliIO,
    private readonly now: () => Date,
  ) {}

  /** Register a source before it starts, so a terminal line shows it while it discovers. */
  start(source: string): void {
    this.sources.set(source, { total: undefined, done: 0, failed: 0, startedAt: undefined, lastPrinted: undefined });
    this.redraw();
  }

  discovered(source: string, total: number): void {
    const state = this.state(source);
    state.total = total;
    state.startedAt = this.now().getTime();
    if (this.terminal()) this.redraw();
    else if (total > 0) this.io.err(`${source}: ${total} Anfragen discovered`);
  }

  update(source: string, event: ProgressEvent): void {
    const state = this.state(source);
    state.done = event.index;
    state.total = event.total;
    if (event.action === "failed") {
      state.failed++;
      this.line(`  ! ${source} ${truncate(event.id, 40)}: ${truncate(event.detail ?? "failed", 100)}`);
    }
    if (this.terminal()) {
      this.redraw();
      return;
    }
    const at = this.now().getTime();
    const last = state.lastPrinted;
    const due =
      event.index === event.total ||
      (last === undefined ? event.index >= EVERY_REFS : event.index - last.done >= EVERY_REFS || at - last.at >= EVERY_MS);
    if (due) {
      state.lastPrinted = { done: event.index, at };
      this.io.err(this.describe(source, state));
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
      if (state.total !== undefined && state.total > 0) this.io.err(this.describe(source, state));
      this.redraw();
    }
  }

  /** Print a line that must stay, clearing a redrawn status line first. */
  line(text: string): void {
    this.clear();
    this.io.err(text);
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
      state = { total: undefined, done: 0, failed: 0, startedAt: undefined, lastPrinted: undefined };
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
    const elapsedMs = state.startedAt === undefined ? 0 : this.now().getTime() - state.startedAt;
    if (state.done > 0 && elapsedMs > 0) {
      const perMinute = (state.done / elapsedMs) * 60_000;
      parts.push(`${perMinute >= 10 ? Math.round(perMinute) : perMinute.toFixed(1)}/min`);
      const remaining = state.total - state.done;
      parts.push(remaining === 0 ? `done in ${duration(elapsedMs)}` : `~${duration((remaining / perMinute) * 60_000)} left`);
    }
    return parts.join(" · ");
  }
}

/** A duration for people: "40s", "12 min", "5h 05m". */
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}
