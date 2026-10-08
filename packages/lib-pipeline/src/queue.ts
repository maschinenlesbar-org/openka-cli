// A plan file: a queue of sync jobs, `ka sync --plan jobs.toml`.
//
// Building a corpus is a queue of windows across sources, and each user wrote the
// same wrapper script around the corpus lock to run one (issue #17):
//
//   [defaults]
//   continue_on_error = true
//
//   [[job]]
//   source = "berlin"
//   since  = "2025-01-01"
//   until  = "2025-12-31"
//
//   [[job]]
//   source = "bund"
//   period = [21, 20, 19, 18]
//   log    = "logs/sync-bund-wp{period}.log"
//
//   [[job]]
//   source = "sachsen-anhalt"
//   since  = "2023-01-01"
//   until  = "2023-12-31"
//   ref    = ["08/2391", "08/2390"]   # only these (issue #27); or retry_failed / only_new
//
// A job whose `period` is a list is one job per period, in that order. `[defaults]`
// gives every job the window fields and `log` it does not set itself. The jobs run
// as `syncJobs` runs them: different parliaments side by side, one parliament's jobs
// one after the other.

import { UsageError, type Problem } from "@maschinenlesbar.org/openka-lib-errors";
import { jobLabel, windowOf, withDefaults, type SyncJobSpec } from "./jobs.js";
import { parseToml, type TomlTable, type TomlValue } from "./toml.js";
import type { SyncWindow } from "./window.js";

/** One job of a plan: its window, its label (`jobLabel`) and where it logs, if anywhere. */
export interface QueueJob extends SyncJobSpec {
  label: string;
  /** The log path with its placeholders filled in, as written (relative paths unresolved). */
  log?: string;
}

export interface SyncQueue {
  jobs: QueueJob[];
  /** False: no job starts after one has failed. Default true, as for several `--source`s. */
  continueOnError: boolean;
}

/** The keys a `[[job]]` table may set. */
export const JOB_KEYS = ["source", "since", "until", "period", "limit", "ref", "retry_failed", "only_new", "log"] as const;
/** The keys `[defaults]` may set. */
export const DEFAULT_KEYS = ["since", "until", "period", "limit", "retry_failed", "only_new", "log", "continue_on_error"] as const;
/** The placeholders a `log` path may use. */
export const LOG_PLACEHOLDERS = ["source", "period", "since", "until", "limit"] as const;

interface Fields extends SyncWindow {
  periods?: number[];
  log?: string;
}

/**
 * Read a plan file. `where` names it in messages; `sourceProblem` is the registry's
 * rule for a source key. Throws `UsageError` naming the file, the job and the field —
 * nothing of a plan runs unless all of it reads.
 */
export function parseSyncQueue(text: string, options: { where?: string; sourceProblem?: Problem<string> } = {}): SyncQueue {
  const where = options.where ?? "plan";
  const doc = parseToml(text, where);
  for (const key of Object.keys(doc)) {
    if (key !== "job" && key !== "defaults") throw new UsageError(`${where}: unknown "${key}"; a plan file has [[job]] tables and one [defaults]`);
  }
  const rawJobs = doc["job"];
  if (rawJobs === undefined || (Array.isArray(rawJobs) && rawJobs.length === 0)) throw new UsageError(`${where}: no [[job]] in the plan`);
  if (!Array.isArray(rawJobs) || !rawJobs.every(isTable)) throw new UsageError(`${where}: "job" must be [[job]] tables`);
  const rawDefaults = doc["defaults"];
  if (rawDefaults !== undefined && !isTable(rawDefaults)) throw new UsageError(`${where}: "defaults" must be a [defaults] table`);

  const defaultsAt = `${where} [defaults]`;
  const defaultTable = (rawDefaults as TomlTable | undefined) ?? {};
  unknownKeys(defaultTable, DEFAULT_KEYS, defaultsAt);
  const defaults = fields(defaultTable, defaultsAt);
  const continueOnError = defaultTable["continue_on_error"];
  if (continueOnError !== undefined && typeof continueOnError !== "boolean") throw new UsageError(`${defaultsAt}: continue_on_error must be true or false`);

  const jobs: QueueJob[] = [];
  const seen = new Map<string, string>();
  (rawJobs as TomlTable[]).forEach((table, index) => {
    const source = table["source"];
    const at = `${where} [[job]] #${index + 1}${typeof source === "string" ? ` (${source})` : ""}`;
    unknownKeys(table, JOB_KEYS, at);
    if (typeof source !== "string") throw new UsageError(`${at}: source is required, a string like "berlin"`);
    const reason = options.sourceProblem?.(source);
    if (reason !== undefined) throw new UsageError(`${at}: source: ${reason}`);
    const own = fields(table, at);
    const periods = own.periods ?? (own.period === undefined ? defaults.periods : undefined);
    for (const period of periods ?? [undefined]) {
      const window: SyncWindow = {
        ...windowOf(own),
        ...(period === undefined ? {} : { period }),
      };
      let spec: SyncJobSpec;
      try {
        // A list of periods in [defaults] is expanded above; `windowOf` carries a single one.
        spec = withDefaults({ source, ...window }, windowOf(defaults));
      } catch (err) {
        throw new UsageError(`${at}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
      }
      // A job's own `false` turns off a default's `true`; `windowOf` carries only `true`.
      if (own.retryFailed === false) delete spec.retryFailed;
      if (own.onlyNew === false) delete spec.onlyNew;
      const label = jobLabel(spec);
      const twice = seen.get(label);
      if (twice !== undefined) throw new UsageError(`${at}: ${label} is the same job as ${twice}`);
      seen.set(label, at);
      const log = own.log ?? defaults.log;
      jobs.push({ ...spec, label, ...(log === undefined ? {} : { log: fillLog(log, spec, at) }) });
    }
  });
  return { jobs, continueOnError: continueOnError ?? true };
}

function isTable(value: unknown): value is TomlTable {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownKeys(table: TomlTable, allowed: readonly string[], at: string): void {
  for (const key of Object.keys(table)) {
    if (!allowed.includes(key)) throw new UsageError(`${at}: unknown key "${key}"; expected ${allowed.join(", ")}`);
  }
}

/** The window fields and `log` of one table, type-checked; `period` may be a list. */
function fields(table: TomlTable, at: string): Fields {
  const out: Fields = {};
  for (const key of ["since", "until", "log"] as const) {
    const value = table[key];
    if (value === undefined) continue;
    if (typeof value !== "string") throw new UsageError(`${at}: ${key} must be a string${key === "log" ? "" : " (YYYY-MM-DD)"}`);
    out[key] = value;
  }
  const ref = table["ref"];
  if (ref !== undefined) {
    const refs = typeof ref === "string" ? [ref] : ref;
    if (!Array.isArray(refs) || refs.length === 0 || !refs.every((r: TomlValue) => typeof r === "string")) {
      throw new UsageError(`${at}: ref must be a reference or a non-empty list of them, like ["08/2391"]`);
    }
    out.refs = refs as string[];
  }
  for (const [key, field] of [["retry_failed", "retryFailed"], ["only_new", "onlyNew"]] as const) {
    const value = table[key];
    if (value === undefined) continue;
    if (typeof value !== "boolean") throw new UsageError(`${at}: ${key} must be true or false`);
    out[field] = value;
  }
  const limit = table["limit"];
  if (limit !== undefined) {
    if (typeof limit !== "number") throw new UsageError(`${at}: limit must be an integer`);
    out.limit = limit;
  }
  const period = table["period"];
  if (period !== undefined) {
    if (typeof period === "number") out.period = period;
    else if (Array.isArray(period) && period.length > 0 && period.every((p: TomlValue) => typeof p === "number")) out.periods = period as number[];
    else throw new UsageError(`${at}: period must be an integer or a non-empty list of integers`);
  }
  return out;
}



/** `log` with `{source}`, `{period}`, … filled from the job; a placeholder the job has no value for is refused. */
function fillLog(template: string, spec: SyncJobSpec, at: string): string {
  return template.replace(/\{([^}]*)\}/g, (_whole, name: string) => {
    if (!(LOG_PLACEHOLDERS as readonly string[]).includes(name)) {
      throw new UsageError(`${at}: log: unknown placeholder {${name}}; expected one of ${LOG_PLACEHOLDERS.map((p) => `{${p}}`).join(", ")}`);
    }
    const value = spec[name as keyof SyncJobSpec];
    if (value === undefined) throw new UsageError(`${at}: log uses {${name}}, but the job has no ${name}`);
    return String(value);
  });
}
