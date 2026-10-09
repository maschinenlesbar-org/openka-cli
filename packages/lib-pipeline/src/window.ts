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

/**
 * The part of the sync options that says what a job covers: the window discovery
 * looks at, and which of the Anfragen it finds are handled (issue #27).
 */
export interface SyncWindow {
  since?: string;
  until?: string;
  period?: number;
  limit?: number;
  /**
   * Handle only these references of the window, and the ones they were filed under
   * before (`DocRef.formerly`). With `retryFailed` too, either one selects.
   */
  refs?: string[];
  /** Handle only the Anfragen whose last attempt failed (`SourceState.failed`). */
  retryFailed?: boolean;
  /**
   * Skip every Anfrage the corpus holds with all its documents, without a request for
   * it; what is missing, or stored without a document, is handled.
   */
  onlyNew?: boolean;
}

/** Whether a window handles less than everything it discovers. */
export function isSelective(window: SyncWindow): boolean {
  return window.refs !== undefined || window.retryFailed === true || window.onlyNew === true;
}

/** The references to sync: at least one, none blank, none with a control character, none twice. */
export const syncRefsProblem: Problem<readonly string[]> = (refs) => {
  if (refs.length === 0) return "Name at least one reference.";
  const seen = new Set<string>();
  for (const ref of refs) {
    if (ref.trim() === "") return "A reference is blank.";
    // A reference is quoted in log records and job labels; a line break or an escape in
    // it would split or forge one, and no real reference holds a control character.
    if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(ref)) return "A reference holds a control character.";
    // A job's label lists its refs between commas (`jobLabel`); no reference has one.
    if (ref.includes(",")) return `"${ref.trim()}" has a comma; name each reference on its own.`;
    if (seen.has(ref.trim())) return `"${ref.trim()}" is named twice.`;
    seen.add(ref.trim());
  }
  return undefined;
};

/**
 * Check a sync window and return it in canonical form (dates trimmed). Throws
 * `OpenKaValidationError` for a `since`/`until` that is not a `YYYY-MM-DD`
 * calendar date, an `until` before `since`, a `period` outside `PERIOD_RANGE` and
 * a `limit` below `SYNC_LIMIT_MIN` (both integers), and `refs` that `syncRefsProblem`
 * refuses (trimmed otherwise). Idempotent; omitted fields stay
 * omitted. `sync()` calls it first.
 */
export function normalizeSyncWindow<T extends SyncWindow>(window: T): T {
  if (window.since !== undefined) assertValid("since", window.since, isoDateProblem);
  if (window.until !== undefined) assertValid("until", window.until, isoDateProblem);
  if (window.period !== undefined) assertValid("period", window.period, syncPeriodProblem);
  if (window.limit !== undefined) assertValid("limit", window.limit, syncLimitProblem);
  if (window.refs !== undefined) assertValid("refs", window.refs, syncRefsProblem);
  const normalized: T = { ...window };
  if (window.refs !== undefined) normalized.refs = window.refs.map((ref) => ref.trim());
  if (window.since !== undefined) normalized.since = normalizeIsoDate(window.since);
  if (window.until !== undefined) normalized.until = normalizeIsoDate(window.until);
  const { since, until } = normalized;
  if (since !== undefined && until !== undefined) {
    assertValid("until", until, (value) => (value < since ? `Must be >= since (${since}).` : undefined));
  }
  return normalized;
}
