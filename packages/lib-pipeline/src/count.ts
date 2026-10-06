// How complete is the corpus? Each source's upstream count beside the records the
// corpus holds for it — `ka sources count`.
//
// `ka sources list` shows what the corpus holds, which cannot answer "how much is
// missing"; sizing a whole collection meant asking DIP and the Parlamentsspiegel by
// hand (issue #5). Each source counts its upstream with a request or two and no
// discovery (`Source.count`), one source after the other. A source that cannot count,
// or cannot count the way it was asked, gets a note instead of a number, never a
// number for something else.

import { assertValid } from "@maschinenlesbar.org/openka-lib-errors";
import type { FetchEngine } from "@maschinenlesbar.org/openka-lib-http";
import { PARLIAMENTS } from "@maschinenlesbar.org/openka-lib-models";
import type { Source } from "@maschinenlesbar.org/openka-lib-source";
import type { CatalogStore } from "@maschinenlesbar.org/openka-lib-store";
import { syncPeriodProblem } from "./window.js";

export interface CountSourcesOptions {
  sources: readonly Source[];
  /** The catalog to count the corpus side from. Nothing is written. */
  store: Pick<CatalogStore, "catalog">;
  /** The engine for one source; build them on one `HostPacer`, as for a sync. */
  engineFor: (source: Source) => FetchEngine;
  apiKeyFor?: (source: Source) => string | undefined;
  /** Count one legislative period, upstream and in the corpus alike. */
  period?: number;
}

export interface SourceCountRow {
  source: string;
  /** Absent for an aggregator, which counts every Land it covers. */
  parliament: string | undefined;
  /** What the upstream says it holds; absent when it could not be asked (`note` says why). */
  upstream?: number;
  /** Where `upstream` comes from: "DIP numFound", "Parlamentsspiegel". */
  basis?: string;
  /** Records the corpus holds for the source's parliament (all Länder for an aggregator). */
  in_corpus: number;
  /** `upstream - in_corpus`, never below zero; absent without `upstream`. */
  missing?: number;
  /** Why `upstream` is absent. */
  note?: string;
  /**
   * The error behind `note`, for a caller that wants to rethrow it — a `UsageError`
   * for a count asked in a way the upstream cannot answer. Not serialisable: leave
   * it out of JSON.
   */
  error?: unknown;
}

/**
 * Count each source's upstream and its records in the corpus, one source after the
 * other. The upstream count of an aggregator-backed Land is the aggregator's, and its
 * `basis` says so. Throws only for a `period` outside `PERIOD_RANGE`; a source that
 * fails to count is a row with a `note`.
 */
export async function countSources(options: CountSourcesOptions): Promise<SourceCountRow[]> {
  if (options.period !== undefined) assertValid("period", options.period, syncPeriodProblem);
  const catalog = options.store.catalog();
  const laender = new Set<string>(PARLIAMENTS.filter((parliament) => parliament.herkunft !== undefined).map((parliament) => parliament.key));
  const rows: SourceCountRow[] = [];
  for (const source of options.sources) {
    const covers = (parliament: string): boolean =>
      source.parliament === undefined ? laender.has(parliament) : parliament === source.parliament;
    const inCorpus = catalog.filter(
      (row) => covers(row.parliament) && (options.period === undefined || row.legislative_period === options.period),
    ).length;
    const row: SourceCountRow = { source: source.key, parliament: source.parliament, in_corpus: inCorpus };
    if (source.count === undefined) {
      row.note = "cannot count its upstream without discovering it; `ka sync --dry-run` does that";
    } else {
      try {
        const apiKey = options.apiKeyFor?.(source);
        const counted = await source.count({
          engine: options.engineFor(source),
          ...(options.period === undefined ? {} : { period: options.period }),
          ...(apiKey === undefined ? {} : { apiKey }),
        });
        row.upstream = counted.total;
        row.basis = counted.basis;
        row.missing = Math.max(0, counted.total - inCorpus);
      } catch (error) {
        row.note = error instanceof Error ? error.message : String(error);
        row.error = error;
      }
    }
    rows.push(row);
  }
  return rows;
}
