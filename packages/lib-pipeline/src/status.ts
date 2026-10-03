// Every source with its adapter status, record count and last sync — the table
// `ka sources list` prints, joined from the registry and the corpus.

import type { SourceEntry, SourceStatus } from "@maschinenlesbar.org/openka-lib-source";
import type { CatalogStore, SourceStateStore } from "@maschinenlesbar.org/openka-lib-store";

export interface SourceStatusRow {
  key: string;
  parliament: string | undefined;
  label: string;
  status: SourceStatus;
  /** Records filed under the source's parliament; absent for an aggregator. */
  records: number | undefined;
  last_sync: string | undefined;
  last_success: string | undefined;
  /** Set while the last sync failed — what makes a source "degraded". */
  last_error: string | undefined;
  note: string;
}

/**
 * One row per registry entry, in registry order. An adapter with no parliament of
 * its own has no record count of its own either: its records are filed under the
 * Länder they came from.
 */
export function sourceStatus(store: CatalogStore & SourceStateStore, registry: readonly SourceEntry[]): SourceStatusRow[] {
  const counts = new Map<string, number>();
  for (const entry of store.catalog()) counts.set(entry.parliament, (counts.get(entry.parliament) ?? 0) + 1);
  return registry.map((entry) => {
    const state = store.getSourceState(entry.key);
    return {
      key: entry.key,
      parliament: entry.parliament,
      label: entry.label,
      status: entry.status,
      records: entry.parliament === undefined ? undefined : (counts.get(entry.parliament) ?? 0),
      last_sync: state.last_sync,
      last_success: state.last_success,
      last_error: state.last_error,
      note: entry.note,
    };
  });
}
