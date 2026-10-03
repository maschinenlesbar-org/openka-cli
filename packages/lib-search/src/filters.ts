// The rules a search filter obeys, owned here so `search()`, `searchLike()` and the
// review queue enforce them and `ka`'s parsers call the very same functions. A
// filter that cannot match anything — an unknown parliament, a blank party, a
// date that is no date — is a usage error on every path, never "No matches.".

import { assertValid, intRangeProblem, isBlank, nonBlankProblem, type Problem } from "@maschinenlesbar.org/openka-lib-errors";
import { parseQuery } from "@maschinenlesbar.org/openka-lib-store";
import {
  PERIOD_RANGE,
  ReviewStatuses,
  isoDateProblem,
  normalizeIsoDate,
  normalizeParliamentKey,
  parliamentKeyProblem,
} from "@maschinenlesbar.org/openka-lib-models";
import type { SearchFilters } from "./search.js";

/** The years `year` may name: the first Bundestag to well past any corpus. */
export const YEAR_RANGE = [1949, 2999] as const;
// Re-exported where search callers have always found them; the rules themselves
// are shared with the sync window (lib-pipeline), so they live below both.
/** The legislative periods `period` may name (lib-models). */
export { PERIOD_RANGE } from "@maschinenlesbar.org/openka-lib-models";
/** An integer in `[min, max]` (lib-errors). */
export { intRangeProblem } from "@maschinenlesbar.org/openka-lib-errors";

/** How many hits `search()` and `searchLike()` return when no `limit` is given. */
export const DEFAULT_SEARCH_LIMIT = 20;
/** The smallest page: a `limit` is an integer of at least this. */
export const LIMIT_MIN = 1;
/** The smallest `offset`: the first hit. */
export const OFFSET_MIN = 0;

/** A page size: an integer >= `LIMIT_MIN`. */
export const limitProblem: Problem<number> = intRangeProblem(LIMIT_MIN);
/** A page start: an integer >= `OFFSET_MIN`. */
export const offsetProblem: Problem<number> = intRangeProblem(OFFSET_MIN);

/**
 * Check the paging contract: `limit` an integer >= 1, `offset` an integer >= 0.
 * Throws `OpenKaValidationError` otherwise. A negative value used to wrap around
 * through `slice` — `offset: -1` answered the last hit, `limit: -1` dropped the
 * last one — next to a `total` that looked right. Upper bounds are not the
 * library's: `ka` caps each command's page for presentation.
 */
export function assertPaging(paging: { limit?: number | undefined; offset?: number | undefined }): void {
  if (paging.limit !== undefined) assertValid("limit", paging.limit, limitProblem);
  if (paging.offset !== undefined) assertValid("offset", paging.offset, offsetProblem);
}

/**
 * A query the tokenizer can use. A blank query means "every record"; a non-blank
 * one with no term left after tokenising (`"???"`, `"a"`, `"-"`) is not the same
 * thing, and answering it with every record is the silently-dropped constraint a
 * blank filter is refused to prevent. A query of only exclusions (`-radwege`)
 * keeps its terms and passes.
 */
export const searchableQueryProblem: Problem<string> = (query) => {
  if (isBlank(query)) return undefined;
  const parsed = parseQuery(query);
  if (parsed.required.length > 0 || parsed.excluded.length > 0) return undefined;
  return (
    `Nothing searchable in ${JSON.stringify(query)} — terms are runs of letters and digits ` +
    "of at least two characters, so this would have matched every record."
  );
};

/** A parliament filter: not blank, and a key that exists (any case). */
export const searchParliamentProblem: Problem<string> = (value) => nonBlankProblem(value) ?? parliamentKeyProblem(value);

/** A review status the corpus can hold — matched exactly, as stored. */
export const reviewStatusProblem: Problem<string> = (value) =>
  (ReviewStatuses as readonly string[]).includes(value) ? undefined : `Allowed choices are ${ReviewStatuses.join(", ")}.`;

const yearProblem = intRangeProblem(...YEAR_RANGE);
const periodProblem = intRangeProblem(...PERIOD_RANGE);

function each<T>(name: string, values: readonly T[] | undefined, problem: Problem<T>): void {
  for (const value of values ?? []) assertValid(name, value, problem);
}

/**
 * Check every filter and return them in canonical form: parliament keys and
 * parties trimmed and lower-cased, dates trimmed. Throws `OpenKaValidationError`
 * for a filter that cannot match — an unknown parliament, a blank party, an
 * unknown review status, a year or period out of range or not an integer, a date
 * that is not `YYYY-MM-DD` on the calendar. `search()`, `searchLike()` and
 * `reviewQueue()` call it first; the result is idempotent.
 */
export function normalizeSearchFilters(filters: SearchFilters): SearchFilters {
  each("parliament", filters.parliament, searchParliamentProblem);
  each("party", filters.party, nonBlankProblem);
  each("reviewStatus", filters.reviewStatus, reviewStatusProblem);
  each("year", filters.year, yearProblem);
  each("period", filters.period, periodProblem);
  if (filters.from !== undefined) assertValid("from", filters.from, isoDateProblem);
  if (filters.to !== undefined) assertValid("to", filters.to, isoDateProblem);

  const normalized: SearchFilters = { ...filters };
  if (filters.parliament !== undefined) normalized.parliament = filters.parliament.map(normalizeParliamentKey);
  if (filters.party !== undefined) normalized.party = filters.party.map((party) => party.trim().toLowerCase());
  if (filters.from !== undefined) normalized.from = normalizeIsoDate(filters.from);
  if (filters.to !== undefined) normalized.to = normalizeIsoDate(filters.to);
  return normalized;
}
