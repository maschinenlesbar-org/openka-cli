// `ka doctor`: one look at everything that decides whether a corpus is safe to write
// to and complete to read from — the volumes it is on, who holds it, whether the
// catalog and the record files agree, and what macOS has left beside its files.

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { StoreError } from "@maschinenlesbar.org/openka-lib-errors";
import { isPlatformFile, type FileStore } from "./file-store.js";
import { catalogGaps } from "./indexer.js";
import { currentReference } from "@maschinenlesbar.org/openka-lib-models";
import { blobsApart, checkCorpusVolumes, type VolumeCheckOptions, type VolumeReport } from "./volume.js";
import { blobSize, orphanedBlobs } from "./remove.js";

export interface CorpusDiagnosis {
  corpus: string;
  /** False before the first sync: then only the volumes are checked. */
  exists: boolean;
  blobs: string;
  volumes: VolumeReport[];
  lock: { state: "free" } | { state: "held" | "stale"; holder: string };
  /** Absent when the catalog or the record files could not be read (`problems` says why). */
  catalog?: {
    records: number;
    catalogued: number;
    /** Record files with no catalog row. */
    uncatalogued: string[];
    /** Catalog rows with no record file. */
    missing_files: string[];
    /**
     * Records filed by an earlier build under a reference this one reads differently,
     * and so under another paper's id (`currentReference`, issue #25).
     */
    misfiled: string[];
  };
  /** macOS `._*` and `.DS_Store` files anywhere in the corpus and the blob store. */
  platform_files: number;
  /**
   * Archived documents no record refers to, when asked for (`orphanedBlobs`): what
   * records removed by hand leave behind. Absent when not asked, or when a record could
   * not be read.
   */
  orphaned_blobs?: { count: number; bytes: number };
  /** What a sync would refuse, or what makes the corpus incomplete. */
  problems: string[];
  warnings: string[];
}

/** Look at the corpus without writing to it. */
export interface DiagnoseOptions extends VolumeCheckOptions {
  /** Also count the orphaned blobs — which reads every record. */
  orphanedBlobs?: boolean;
}

export function diagnoseCorpus(store: FileStore, options: DiagnoseOptions = {}): CorpusDiagnosis {
  const volumes = checkCorpusVolumes(store, options);
  const problems = volumes.flatMap((volume) => volume.problems);
  const blobStore = store.blobStoreProblem();
  if (blobStore !== undefined) problems.push(blobStore);
  const warnings = volumes.flatMap((volume) => volume.warnings);
  const exists = existsSync(store.root);
  const held = store.lockStatus();
  const lock: CorpusDiagnosis["lock"] = held === undefined ? { state: "free" } : { state: held.stale ? "stale" : "held", holder: held.holder };
  if (lock.state === "stale") warnings.push(`a lock was left by a run that is gone (${lock.holder}); the next writer takes it over`);

  const diagnosis: CorpusDiagnosis = {
    corpus: store.root,
    exists,
    blobs: store.blobsRoot,
    volumes,
    lock,
    platform_files: 0,
    problems,
    warnings,
  };
  if (!exists) return diagnosis;
  if (!statSync(store.root).isDirectory()) {
    problems.push(`${store.root} is not a directory, so it cannot be a corpus.`);
    return diagnosis;
  }

  try {
    const gaps = catalogGaps(store);
    const rows = store.catalog();
    const misfiled = rows.filter((row) => currentReference(row) !== undefined).map((row) => row.id);
    diagnosis.catalog = {
      records: store.recordIds().length,
      catalogued: rows.length,
      uncatalogued: gaps.uncatalogued,
      missing_files: gaps.missingFiles,
      misfiled,
    };
    if (misfiled.length > 0) {
      problems.push(
        `${misfiled.length} record(s) hold the id of another paper — an earlier build filed them under a reference this one ` +
          `reads differently (${misfiled.slice(0, 5).join(", ")}${misfiled.length > 5 ? ", …" : ""}); a sync refuses to overwrite them, ` +
          "and `ka reextract --all` moves them",
      );
    }
    if (gaps.uncatalogued.length > 0 || gaps.missingFiles.length > 0) {
      problems.push(
        `the catalog and the record files disagree: ${gaps.uncatalogued.length} record file(s) are not in the catalog and ` +
          `${gaps.missingFiles.length} catalog row(s) have no file — \`ka reindex\` rebuilds the catalog from the records`,
      );
    }
  } catch (err) {
    if (!(err instanceof StoreError)) throw err;
    problems.push(err.message);
  }

  if (options.orphanedBlobs === true && blobStore === undefined) {
    try {
      const orphans = orphanedBlobs(store);
      if (orphans === undefined) {
        warnings.push("a record could not be read, so the documents no record refers to cannot be counted");
      } else {
        diagnosis.orphaned_blobs = { count: orphans.length, bytes: orphans.reduce((sum, digest) => sum + blobSize(store, digest), 0) };
        if (orphans.length > 0) {
          warnings.push(`${orphans.length} archived document(s) no record refers to; \`ka rm --orphaned-documents\` removes them (--move-to <dir> moves them)`);
        }
      }
    } catch (err) {
      if (!(err instanceof StoreError)) throw err;
      problems.push(err.message);
    }
  }

  diagnosis.platform_files = platformFiles(store).length;
  if (diagnosis.platform_files > 0) {
    warnings.push(`${diagnosis.platform_files} macOS ._* / .DS_Store file(s) lie in the corpus; \`ka doctor --fix\` removes them`);
  }
  return diagnosis;
}

/**
 * Every platform file (`isPlatformFile`) under the corpus and, when it is apart, the
 * blob store, sorted. Symbolic links are not followed.
 */
export function platformFiles(store: Pick<FileStore, "root" | "blobsRoot">): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (isPlatformFile(entry.name)) found.push(path);
      else if (entry.isDirectory()) walk(path);
    }
  };
  walk(store.root);
  if (blobsApart(store)) walk(store.blobsRoot);
  return found.sort();
}

/**
 * Remove every platform file, holding the corpus lock so no sync writes meanwhile.
 * Returns how many were removed. Only `._*` and `.DS_Store` files are touched —
 * names the store never writes (`isPlatformFile`).
 */
export function removePlatformFiles(store: FileStore): number {
  const release = store.lock("doctor --fix");
  try {
    // Taking the lock on such a volume wrote `._lock`; it goes when the lock does.
    const own = join(store.root, "._lock");
    const files = platformFiles(store).filter((path) => path !== own);
    for (const path of files) {
      try {
        rmSync(path, { force: true });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new StoreError(`Could not remove ${path}: ${reason}`, { cause: err });
      }
    }
    return files.length;
  } finally {
    release();
  }
}
