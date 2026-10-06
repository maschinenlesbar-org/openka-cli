// What is in a corpus, counted from its catalog — the numbers `ka stats` prints.

import type { CatalogStore, RecordStore } from "./store.js";
import { catalogGaps } from "./indexer.js";

export interface ParliamentStats {
  records: number;
  /** Records with at least one abstained field. */
  abstained: number;
}

export interface CorpusStats {
  records: number;
  /** Records the extractor completed without abstaining anywhere. */
  parse_complete: number;
  /** Records with at least one abstained field — verified by a person or not. */
  needs_review: number;
  /** Per parliament, keys sorted. */
  by_parliament: Record<string, ParliamentStats>;
  /** Records per extraction tier, keys sorted. */
  by_tier: Record<string, number>;
  /**
   * Record files the catalog has no row for, sorted — on disk but not counted
   * above, and invisible to search and export. `catalogGaps` explains; `ka
   * reindex` closes the gap.
   */
  uncatalogued: string[];
}

const byKey = <T>([a]: [string, T], [b]: [string, T]): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Count the corpus from its catalog; no record is read. The record files are
 * listed (not read) to name those the catalog lacks.
 */
export function corpusStats(store: CatalogStore & Pick<RecordStore, "recordIds">): CorpusStats {
  const catalog = store.catalog();
  const byParliament = new Map<string, ParliamentStats>();
  const byTier = new Map<string, number>();
  for (const entry of catalog) {
    const bucket = byParliament.get(entry.parliament) ?? { records: 0, abstained: 0 };
    bucket.records++;
    if (entry.abstained > 0) bucket.abstained++;
    byParliament.set(entry.parliament, bucket);
    byTier.set(entry.tier, (byTier.get(entry.tier) ?? 0) + 1);
  }
  const complete = catalog.filter((entry) => entry.abstained === 0).length;
  return {
    records: catalog.length,
    parse_complete: complete,
    needs_review: catalog.length - complete,
    by_parliament: Object.fromEntries([...byParliament].sort(byKey)),
    by_tier: Object.fromEntries([...byTier].sort(byKey)),
    uncatalogued: catalogGaps(store).uncatalogued,
  };
}
