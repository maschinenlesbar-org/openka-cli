// The rules a search filter obeys, owned here so `search()`, `searchLike()` and the
// review queue enforce them and `ka`'s parsers call the very same functions. A
// filter that cannot match anything — an unknown parliament, a blank party, a
// date that is no date — is a usage error on every path, never "No matches.".

import { assertValid, nonBlankProblem, type Problem } from "@maschinenlesbar.org/openka-lib-errors";
import {
  ReviewStatuses,
  isoDateProblem,
  normalizeIsoDate,
  normalizeParliamentKey,
  parliamentKeyProblem,
} from "@maschinenlesbar.org/openka-lib-models";
import type { SearchFilters } from "./search.js";

/** The years `year` may name: the first Bundestag to well past any corpus. */
export const YEAR_RANGE = [1949, 2999] as const;
/** The legislative periods `period` may name. */
export const PERIOD_RANGE = [1, 99] as const;

/** An integer in `[min, max]`; the reasons read as `ka`'s parsers print them. */
export function intRangeProblem(min: number, max?: number): Problem<number> {
  return (value) => {
    if (!Number.isSafeInteger(value)) return "Expected an integer.";
    if (value < min) return `Must be >= ${min}.`;
    if (max !== undefined && value > max) return `Must be <= ${max}.`;
    return undefined;
  };
}

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
