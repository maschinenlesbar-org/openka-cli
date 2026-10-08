// `ka stats --by …`: the corpus broken down by party, ministry, month, year,
// period or parliament — or two of them at once — counted from the catalog
// (issue #16). Describing a corpus used to take `ka export --format csv` and a
// script; these are the first numbers anyone asks for.

import { UsageError, assertValid, type Problem } from "@maschinenlesbar.org/openka-lib-errors";
import type { CatalogEntry } from "@maschinenlesbar.org/openka-lib-store";
import { normalizeSearchFilters, partyKey } from "./filters.js";
import { matchesFilters, undatedMatch, type SearchFilters } from "./search.js";

/** What `ka stats --by` can break a corpus down by. */
export const STATS_DIMENSIONS = ["party", "ministry", "month", "year", "period", "parliament"] as const;
export type StatsDimension = (typeof STATS_DIMENSIONS)[number];

/** The most dimensions one breakdown crosses. */
export const MAX_STATS_DIMENSIONS = 2;

/** The label of a row with no value in that dimension. */
export const NONE = "(none)";
/** The label of a row with no question date, in a date dimension. */
export const UNDATED = "(undated)";
/** The label of a row catalogued before the field was indexed (`ka reindex` adds it). */
export const NOT_INDEXED = "(not indexed)";

/** Why `by` cannot be a breakdown: unknown, repeated, or more than `MAX_STATS_DIMENSIONS`. */
export const statsDimensionsProblem: Problem<readonly string[]> = (by) => {
  for (const dimension of by) {
    if (!(STATS_DIMENSIONS as readonly string[]).includes(dimension)) return `"${dimension}" is not one of ${STATS_DIMENSIONS.join(", ")}.`;
  }
  if (new Set(by).size !== by.length) return "A dimension is named twice.";
  if (by.length > MAX_STATS_DIMENSIONS) return `At most ${MAX_STATS_DIMENSIONS} dimensions, for a cross-tab.`;
  return undefined;
};

export interface BreakdownRow {
  /** The row's value in each dimension, in the order of `by`. */
  keys: (string | number)[];
  records: number;
  /** Of those, records with at least one abstained field. */
  needs_review: number;
}

export interface StatsBreakdown {
  by: StatsDimension[];
  rows: BreakdownRow[];
  /**
   * True when a record can fall into several rows of one dimension — a question asked
   * by two parties counts for both — so the rows add up to more than the records.
   */
  overlapping: boolean;
}

/** One row's values in a dimension; a party dimension gives one per party. */
function valuesOf(entry: CatalogEntry, dimension: StatsDimension, label: (key: string) => string): (string | number)[] {
  switch (dimension) {
    case "party": {
      const parties = entry.party_labels ?? entry.parties;
      return parties.length === 0 ? [NONE] : [...new Set(parties.map((party) => label(partyKey(party))))];
    }
    case "ministry":
      // `questions` is indexed with `ministry`; a row without it predates both.
      return [entry.ministry ?? (entry.questions === undefined ? NOT_INDEXED : NONE)];
    case "month":
      return [entry.submitted?.slice(0, 7) ?? UNDATED];
    case "year":
      return [entry.year ?? UNDATED];
    case "period":
      return [entry.legislative_period];
    case "parliament":
      return [entry.parliament];
  }
}

/** Time runs forward; everything else is ordered by size, largest first. */
const CHRONOLOGICAL: readonly StatsDimension[] = ["month", "year", "period"];

/**
 * Count `entries` by the values of `by` — one dimension, or two crossed. A party is
 * grouped by `partyKey` (Bayern's "GRU" and Hessen's "BÜNDNIS 90/DIE GRÜNEN" are one
 * party) and printed in its most frequent spelling. Rows are ordered by time in
 * `month`/`year`/`period` (undated last), and by size elsewhere.
 */
export function statsBreakdown(entries: readonly CatalogEntry[], by: readonly StatsDimension[]): StatsBreakdown {
  assertValid("by", by, statsDimensionsProblem);
  if (by.length === 0) throw new UsageError("Name at least one dimension to break the corpus down by.");

  // The spelling a party key is shown in: the one most records use.
  const spellings = new Map<string, Map<string, number>>();
  for (const entry of entries) {
    for (const party of entry.party_labels ?? entry.parties) {
      const forKey = spellings.get(partyKey(party)) ?? new Map<string, number>();
      forKey.set(party, (forKey.get(party) ?? 0) + 1);
      spellings.set(partyKey(party), forKey);
    }
  }
  const label = (key: string): string => {
    const forKey = [...(spellings.get(key) ?? new Map<string, number>())];
    forKey.sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0));
    return forKey[0]?.[0] ?? key;
  };

  const rows = new Map<string, BreakdownRow>();
  const totals = by.map(() => new Map<string | number, number>());
  let overlapping = false;
  for (const entry of entries) {
    const values = by.map((dimension) => valuesOf(entry, dimension, label));
    if (values.some((list) => list.length > 1)) overlapping = true;
    values.forEach((list, index) => {
      for (const value of list) totals[index]?.set(value, (totals[index]?.get(value) ?? 0) + 1);
    });
    for (const keys of cross(values)) {
      const id = JSON.stringify(keys);
      const row = rows.get(id) ?? { keys, records: 0, needs_review: 0 };
      row.records++;
      if (entry.abstained > 0) row.needs_review++;
      rows.set(id, row);
    }
  }

  const rank = by.map((dimension, index) => {
    const values = [...(totals[index] ?? new Map<string | number, number>())];
    const placeholder = (value: string | number): boolean => value === UNDATED || value === NONE || value === NOT_INDEXED;
    values.sort(([a, x], [b, y]) => {
      if (placeholder(a) !== placeholder(b)) return placeholder(a) ? 1 : -1;
      if (CHRONOLOGICAL.includes(dimension)) return a < b ? -1 : a > b ? 1 : 0;
      return y - x || (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);
    });
    return new Map(values.map(([value], position) => [value, position]));
  });
  const ordered = [...rows.values()].sort((a, b) => {
    for (const [index, order] of rank.entries()) {
      const delta = (order.get(a.keys[index] as string | number) ?? 0) - (order.get(b.keys[index] as string | number) ?? 0);
      if (delta !== 0) return delta;
    }
    return 0;
  });
  return { by: [...by], rows: ordered, overlapping };
}

function cross(lists: (string | number)[][]): (string | number)[][] {
  return lists.reduce<(string | number)[][]>((out, list) => out.flatMap((prefix) => list.map((value) => [...prefix, value])), [[]]);
}

/**
 * The catalog rows the search filters select, as a predicate for `corpusStats`
 * (lib-store) and the rows for `statsBreakdown`, with how many were left out only for
 * lacking a question date — what `search()` calls `undated`.
 */
export function statsSelection(entries: readonly CatalogEntry[], filters: SearchFilters): { entries: CatalogEntry[]; undated: number; where: (entry: CatalogEntry) => boolean } {
  const normalized = normalizeSearchFilters(filters);
  const where = (entry: CatalogEntry): boolean => matchesFilters(entry, normalized);
  return {
    entries: entries.filter(where),
    undated: entries.filter((entry) => undatedMatch(entry, normalized)).length,
    where,
  };
}
