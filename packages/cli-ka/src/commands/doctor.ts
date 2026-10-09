// `ka doctor` — whether the corpus is safe to write to and complete to read from:
// the volumes it is on, its lock, the catalog against the record files, and the
// files macOS leaves beside it. Read-only, except `--fix`.

import { existsSync } from "node:fs";
import type { Command } from "commander";
import { OpenKaError, StoreError } from "@maschinenlesbar.org/openka-lib-errors";
import { FileStore, diagnoseCorpus, removePlatformFiles, type CorpusDiagnosis, type VolumeReport } from "@maschinenlesbar.org/openka-lib-store";
import { logOf, type CliDeps, type CliIO } from "../io.js";
import type { Logger } from "../log.js";
import { action, addVolumeOptions, printJson, volumeOptionsFrom } from "../shared.js";
import { formatBytes, formatCount, pad, sanitizeForTerminal } from "../text.js";

export function registerDoctor(program: Command, deps: CliDeps): void {
  const command = program
    .command("doctor")
    .description("check the corpus: filesystem, free space, lock, catalog against records, macOS ._* files (exit 3 on a problem)")
    .option("--fix", "remove the macOS ._* and .DS_Store files from the corpus (takes the corpus lock)")
    .option("--orphaned-documents", "also count the archived documents no record refers to (reads every record)")
    .option("--json", "print the diagnosis as JSON");
  addVolumeOptions(command).action(
    action(
      deps,
      async (ctx) => {
        const store = ctx.store();
        if (!(store instanceof FileStore)) throw new OpenKaError("ka doctor needs a corpus on disk.");
        // `--fix` takes the lock, so it refuses (exit 3) while a sync writes; before
        // the first sync there is nothing to fix.
        const removed = ctx.opts["fix"] === true && existsSync(store.root) ? removePlatformFiles(store) : undefined;
        const diagnosis = diagnoseCorpus(store, { ...volumeOptionsFrom(ctx), ...(ctx.opts["orphanedDocuments"] === true ? { orphanedBlobs: true } : {}) });
        if (ctx.opts["json"] === true) {
          printJson(ctx, removed === undefined ? diagnosis : { ...diagnosis, removed_platform_files: removed });
        } else {
          printDiagnosis(ctx.deps.io, logOf(ctx.deps), diagnosis, removed);
        }
        if (diagnosis.problems.length > 0) {
          throw new StoreError(`${diagnosis.problems.length} problem(s) with the corpus at ${diagnosis.corpus}.`);
        }
      },
      // The doctor counts the platform files itself and names its own remedy.
      { noteIgnored: false },
    ),
  );
}

function printDiagnosis(io: CliIO, log: Logger, diagnosis: CorpusDiagnosis, removed: number | undefined): void {
  const row = (label: string, value: string): void => io.out(`${pad(label, 13)} ${value}`);
  const volume = (report: VolumeReport | undefined): void => {
    if (report === undefined) return;
    row("  filesystem", report.filesystem === undefined ? "unknown" : `${report.filesystem.name} (${report.filesystem.kind})`);
    if (report.space !== undefined) row("  free", `${formatBytes(report.space.free)} of ${formatBytes(report.space.total)}`);
  };
  const byRole = (role: VolumeReport["role"]): VolumeReport | undefined => diagnosis.volumes.find((report) => report.role === role);

  row("corpus", `${sanitizeForTerminal(diagnosis.corpus)}${diagnosis.exists ? "" : " (not created yet)"}`);
  volume(byRole("corpus"));
  const blobs = byRole("blobs");
  row("blobs", blobs === undefined ? "in the corpus" : sanitizeForTerminal(diagnosis.blobs));
  volume(blobs);
  row(
    "lock",
    diagnosis.lock.state === "free"
      ? "free"
      : `${diagnosis.lock.state === "stale" ? "stale, left by" : "held by"} ${sanitizeForTerminal(diagnosis.lock.holder)}`,
  );
  const catalog = diagnosis.catalog;
  if (catalog !== undefined) {
    const gaps = catalog.uncatalogued.length + catalog.missing_files.length;
    row(
      "catalog",
      gaps === 0
        ? `${formatCount(catalog.records)} record(s), all catalogued`
        : `${formatCount(catalog.records)} record file(s), ${formatCount(catalog.catalogued)} catalog row(s): ` +
            `${formatCount(catalog.uncatalogued.length)} uncatalogued, ${formatCount(catalog.missing_files.length)} without a file`,
    );
  }
  if (removed !== undefined) row("removed", `${formatCount(removed)} macOS ._* / .DS_Store file(s)`);
  const orphans = diagnosis.orphaned_blobs;
  if (orphans !== undefined) {
    row("documents", orphans.count === 0 ? "every archived document belongs to a record" : `${formatCount(orphans.count)} archived document(s) no record refers to (${formatBytes(orphans.bytes)})`);
  }
  if (diagnosis.exists) row("platform", diagnosis.platform_files === 0 ? "no macOS ._* / .DS_Store files" : `${formatCount(diagnosis.platform_files)} macOS ._* / .DS_Store file(s)`);

  for (const warning of diagnosis.warnings) log.warn("doctor", warning);
  for (const problem of diagnosis.problems) log.error("doctor", problem);
  if (diagnosis.problems.length === 0) io.out("No problems found.");
}
