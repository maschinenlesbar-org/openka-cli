// A sync job: one source over one window. `ka sync --source berlin@2025-01-01..2025-12-31`
// and every job of a plan file (`queue.ts`) are one of these.
//
// Several `--source` flags used to share one `--since/--until/--period/--limit`, so
// "Berlin 2025 and the Bundestag 2026" could not run in one process under one lock,
// and the Bundestag one Wahlperiode after the other took a shell loop around the lock
// (issue #17). A job carries its own window, and one source may appear in several
// jobs as long as their windows differ.

import { OpenKaValidationError, assertValid, type Problem } from "@maschinenlesbar.org/openka-lib-errors";
import { isoDateProblem } from "@maschinenlesbar.org/openka-lib-models";
import { normalizeSyncWindow, syncLimitProblem, syncPeriodProblem, type SyncWindow } from "./window.js";

/** A job as written: a source key and the window it syncs. */
export interface SyncJobSpec extends SyncWindow {
  source: string;
}

/**
 * The job's name in output, logs and a plan's progress: the source key alone for a
 * job without a window of its own, otherwise `key@since..until,period=N,limit=N`
 * with only the parts it has — the same text `parseJobSpec` reads.
 */
export function jobLabel(spec: SyncJobSpec): string {
  const parts: string[] = [];
  if (spec.since !== undefined || spec.until !== undefined) parts.push(`${spec.since ?? ""}..${spec.until ?? ""}`);
  if (spec.period !== undefined) parts.push(`period=${spec.period}`);
  if (spec.limit !== undefined) parts.push(`limit=${spec.limit}`);
  return parts.length === 0 ? spec.source : `${spec.source}@${parts.join(",")}`;
}

/** The non-negative decimal integer `text` spells, or undefined. */
function integerOf(text: string): number | undefined {
  return /^\d+$/.test(text) && Number.isSafeInteger(Number(text)) ? Number(text) : undefined;
}

/** The grammar, for every message that refuses a spec. */
const SPEC_SYNTAX =
  "Expected <source>[@<window>], the window one or more of SINCE..UNTIL (either side may be empty), " +
  "since=YYYY-MM-DD, until=YYYY-MM-DD, period=N and limit=N, separated by commas — like bund@period=21 " +
  "or berlin@2025-01-01..2025-12-31.";

/**
 * Read `berlin`, `berlin@2025-01-01..2025-12-31`, `bund@period=21` or
 * `bund@2026-01-01..,limit=50`. The window obeys `normalizeSyncWindow`; whether the
 * key names a source is the caller's `sourceProblem` (the registry's rule), since
 * this package does not know the registry. Throws `OpenKaValidationError`.
 */
export function parseJobSpec(text: string, options: { sourceProblem?: Problem<string> } = {}): SyncJobSpec {
  const at = text.indexOf("@");
  const source = at < 0 ? text : text.slice(0, at);
  if (options.sourceProblem !== undefined) assertValid("source", source, options.sourceProblem);
  if (at < 0) return { source };
  const body = text.slice(at + 1);
  const spec: SyncJobSpec = { source };
  const refuse = (reason: string): never => {
    const full = `${reason} ${SPEC_SYNTAX}`;
    throw new OpenKaValidationError(`Invalid source: ${full}`, { reason: full });
  };
  if (body.trim() === "") refuse(`"${text}" has an empty window.`);
  const set = <K extends keyof SyncWindow>(key: K, value: SyncWindow[K]): void => {
    const window: SyncWindow = spec;
    if (window[key] !== undefined) refuse(`"${text}" sets ${key} twice.`);
    window[key] = value;
  };
  for (const part of body.split(",")) {
    const range = /^(.*)\.\.(.*)$/.exec(part);
    const assignment = /^(since|until|period|limit)=(.*)$/.exec(part);
    if (range !== null) {
      const [, since = "", until = ""] = range;
      if (since === "" && until === "") refuse(`"${part}" is an empty range.`);
      if (since !== "") set("since", dateOf(since, text, refuse));
      if (until !== "") set("until", dateOf(until, text, refuse));
    } else if (assignment !== null) {
      const [, key, value = ""] = assignment;
      if (key === "since" || key === "until") {
        set(key, dateOf(value, text, refuse));
      } else {
        const n = integerOf(value);
        const problem = key === "period" ? syncPeriodProblem : syncLimitProblem;
        const reason = n === undefined ? "Expected an integer." : problem(n);
        if (reason !== undefined) refuse(`${key} in "${text}": ${reason}`);
        set(key as "period" | "limit", n);
      }
    } else {
      refuse(`"${part}" in "${text}" is not a window.`);
    }
  }
  return normalizeSyncWindow(spec);
}

function dateOf(value: string, text: string, refuse: (reason: string) => never): string {
  const reason = isoDateProblem(value);
  if (reason !== undefined) refuse(`"${value}" in "${text}": ${reason}`);
  return value;
}

/** Why `text` is not a job spec `parseJobSpec` reads, or undefined. */
export function jobSpecProblem(text: string, options: { sourceProblem?: Problem<string> } = {}): string | undefined {
  try {
    parseJobSpec(text, options);
    return undefined;
  } catch (err) {
    const reason = (err as { reason?: unknown }).reason;
    return typeof reason === "string" ? reason : err instanceof Error ? err.message : String(err);
  }
}

/**
 * A job's window field by field: what the job sets, else the default (`ka sync`'s
 * `--since/--until/--period/--limit`, a plan's `[defaults]`). The result is checked as
 * one window, so a job's `until` before a default `since` is refused.
 */
export function withDefaults(spec: SyncJobSpec, defaults: SyncWindow): SyncJobSpec {
  return normalizeSyncWindow({ source: spec.source, ...windowOf(defaults), ...windowOf(spec) });
}

/** Only the window fields that are set — so spreading one never writes an `undefined` over a value. */
export function windowOf(window: SyncWindow): SyncWindow {
  const out: SyncWindow = {};
  if (window.since !== undefined) out.since = window.since;
  if (window.until !== undefined) out.until = window.until;
  if (window.period !== undefined) out.period = window.period;
  if (window.limit !== undefined) out.limit = window.limit;
  return out;
}
