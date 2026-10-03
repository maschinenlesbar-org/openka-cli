// The rules a sync window and budget obey, owned here so `sync()` enforces them
// before it reads source state or asks an upstream anything, and `ka sync`'s
// parsers call the very same functions. A padded date used to reach DIP as
// `f.datum.start=%202024-…` and Berlin's string comparison as a window that
// excluded everything; period 0 went out as `f.wahlperiode=0`; a negative limit
// cut the discovered set from the end through `slice`.

import { assertValid, intRangeProblem, type Problem } from "@maschinenlesbar.org/openka-lib-errors";
import { PERIOD_RANGE, isoDateProblem, normalizeIsoDate } from "@maschinenlesbar.org/openka-lib-models";

/** The smallest sync budget: a `limit` is an integer of at least this. */
export const SYNC_LIMIT_MIN = 1;

/** A sync budget: an integer >= `SYNC_LIMIT_MIN`. */
export const syncLimitProblem: Problem<number> = intRangeProblem(SYNC_LIMIT_MIN);
/** A legislative period to sync: an integer in `PERIOD_RANGE`. */
export const syncPeriodProblem: Problem<number> = intRangeProblem(...PERIOD_RANGE);

/** The part of the sync options that selects what is discovered. */
export interface SyncWindow {
  since?: string;
  until?: string;
  period?: number;
  limit?: number;
}

/**
 * Check a sync window and return it in canonical form (dates trimmed). Throws
 * `OpenKaValidationError` for a `since`/`until` that is not a `YYYY-MM-DD`
 * calendar date, an `until` before `since`, a `period` outside `PERIOD_RANGE` and
 * a `limit` below `SYNC_LIMIT_MIN` (both integers). Idempotent; omitted fields stay
 * omitted. `sync()` calls it first.
 */
export function normalizeSyncWindow<T extends SyncWindow>(window: T): T {
  if (window.since !== undefined) assertValid("since", window.since, isoDateProblem);
  if (window.until !== undefined) assertValid("until", window.until, isoDateProblem);
  if (window.period !== undefined) assertValid("period", window.period, syncPeriodProblem);
  if (window.limit !== undefined) assertValid("limit", window.limit, syncLimitProblem);
  const normalized: T = { ...window };
  if (window.since !== undefined) normalized.since = normalizeIsoDate(window.since);
  if (window.until !== undefined) normalized.until = normalizeIsoDate(window.until);
  const { since, until } = normalized;
  if (since !== undefined && until !== undefined) {
    assertValid("until", until, (value) => (value < since ? `Must be >= since (${since}).` : undefined));
  }
  return normalized;
}
