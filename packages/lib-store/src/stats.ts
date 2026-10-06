// What is in a corpus, counted from its catalog — the numbers `ka stats` prints.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CatalogStore, RecordStore } from "./store.js";
import { catalogGaps } from "./indexer.js";
import { isPlatformFile, type FileStore } from "./file-store.js";

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
  /** Catalog rows whose record file is gone, sorted — counted above, but nothing to read. */
  missing_files: string[];
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
  const gaps = catalogGaps(store);
  return {
    records: catalog.length,
    parse_complete: complete,
    needs_review: catalog.length - complete,
    by_parliament: Object.fromEntries([...byParliament].sort(byKey)),
    by_tier: Object.fromEntries([...byTier].sort(byKey)),
    uncatalogued: gaps.uncatalogued,
    missing_files: gaps.missingFiles,
  };
}

/** Files and their total size. */
export interface DiskUsage {
  files: number;
  bytes: number;
}

export interface CorpusDiskUsage {
  /** The archived documents, `blobs/`. */
  blobs: DiskUsage;
  /** The canonical records, `records/`. */
  records: DiskUsage;
  /** The catalog, the inverted index and any embeddings, `index/`. */
  index: DiskUsage;
  /**
   * Per source, the archived documents its syncs brought in — read from its
   * validators (`SourceState.http_cache`), so a document two sources share counts
   * for both. Keys sorted. What `ka sync --dry-run` averages for its estimate.
   */
  by_source: Record<string, DiskUsage>;
}

/**
 * What the corpus takes on disk: every file under `blobs/`, `records/` and `index/`
 * is listed and its size read (nothing is opened), so on a large corpus this costs
 * one `stat` per file — which is why `ka stats` only does it when asked (`--disk`).
 * Platform files (`isPlatformFile`) are not counted.
 */
export function corpusDiskUsage(store: FileStore): CorpusDiskUsage {
  const bySource: Record<string, DiskUsage> = {};
  for (const key of store.sourceStateKeys()) {
    const usage: DiskUsage = { files: 0, bytes: 0 };
    const digests = new Set(Object.values(store.getSourceState(key).http_cache).map((entry) => entry.sha256));
    for (const digest of digests) {
      if (digest === undefined || !store.hasBlob(digest)) continue;
      usage.files++;
      usage.bytes += statSync(store.blobPath(digest)).size;
    }
    bySource[key] = usage;
  }
  return {
    blobs: directoryUsage(join(store.root, "blobs")),
    records: directoryUsage(join(store.root, "records")),
    index: directoryUsage(join(store.root, "index")),
    by_source: bySource,
  };
}

function directoryUsage(dir: string): DiskUsage {
  const usage: DiskUsage = { files: 0, bytes: 0 };
  if (!existsSync(dir)) return usage;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (isPlatformFile(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const inner = directoryUsage(path);
      usage.files += inner.files;
      usage.bytes += inner.bytes;
    } else if (entry.isFile()) {
      usage.files++;
      usage.bytes += statSync(path).size;
    }
  }
  return usage;
}
