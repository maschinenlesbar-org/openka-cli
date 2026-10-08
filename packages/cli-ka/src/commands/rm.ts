// `ka rm` — take records out of the corpus under the lock, with their catalog rows and
// index postings, and optionally the archived documents only they referred to (issue
// #28). The rules and the writing are lib-store's `removeRecords`; this picks the
// records and renders the report.

import type { Command } from "commander";
import { UsageError } from "@maschinenlesbar.org/openka-lib-errors";
import { selectRecords } from "@maschinenlesbar.org/openka-lib-search";
import { removeOrphanedBlobs, removeRecords, type RemoveReport } from "@maschinenlesbar.org/openka-lib-store";
import type { CliDeps, CliIO } from "../io.js";
import { action, addCorpusFilters, corpusFiltersFrom, noteUndated, parseNonEmpty, parseRecordId, printJson, type ActionContext } from "../shared.js";
import { formatBytes, formatCount, sanitizeForTerminal } from "../text.js";

export function registerRm(program: Command, deps: CliDeps): void {
  const command = program
    .command("rm")
    .description("remove records from the corpus, with their catalog rows and index postings (takes the corpus lock)")
    .argument("[ids...]", "record ids; or select with the filters", collectRecordId)
    .option("--documents", "also remove their archived documents that no remaining record refers to")
    .option("--orphaned-documents", "remove every archived document no record refers to, and no record")
    .option("--move-to <dir>", "move the files under this directory (records/, blobs/) instead of deleting them", parseNonEmpty)
    .option("--dry-run", "say what would be removed, and change nothing")
    .option("--json", "print the report as JSON");
  addCorpusFilters(command).action(
    action(deps, async (ctx, positionals) => {
      const ids = (positionals[0] as unknown as string[] | undefined) ?? [];
      const store = ctx.existingStore();
      const to = ctx.opts["moveTo"] as string | undefined;
      const dryRun = ctx.opts["dryRun"] === true;
      let report: RemoveReport;
      if (ctx.opts["orphanedDocuments"] === true) {
        if (ids.length > 0 || Object.keys(corpusFiltersFrom(ctx.opts)).length > 0 || ctx.opts["documents"] === true) {
          throw new UsageError("--orphaned-documents removes documents, not records; leave out the ids, the filters and --documents.");
        }
        report = removeOrphanedBlobs(store, { ...(to === undefined ? {} : { to }), dryRun });
      } else {
        const selected = selectIds(ctx, ids);
        if (selected.length === 0) {
          ctx.deps.io.out("No record matches the filters; nothing was removed.");
          return;
        }
        report = removeRecords(store, {
          ids: selected,
          ...(ctx.opts["documents"] === true ? { blobs: true } : {}),
          ...(to === undefined ? {} : { to }),
          dryRun,
        });
      }
      if (ctx.opts["json"] === true) printJson(ctx, report);
      else printReport(ctx.deps.io, report);
    }),
  );
}

/** commander accumulator for the variadic ids. */
function collectRecordId(value: string, previous: string[] = []): string[] {
  return previous.concat([parseRecordId(value)]);
}

/** The records named: ids or the filters — never both, never neither, and never "everything" by omission. */
function selectIds(ctx: ActionContext, ids: string[]): string[] {
  const filters = corpusFiltersFrom(ctx.opts);
  const filtered = Object.keys(filters).length > 0;
  if (ids.length > 0 && filtered) throw new UsageError("Name records by id, or select them with the filters — not both.");
  if (ids.length > 0) return ids;
  if (!filtered) throw new UsageError("Name the records to remove: ids, or filters such as --parliament sachsen-anhalt --year 2026.");
  const selected = selectRecords(ctx.existingStore(), "", filters);
  noteUndated(ctx, selected.undated);
  return selected.records.map((record) => record.id);
}

function printReport(io: CliIO, report: RemoveReport): void {
  const verb = report.dry_run ? "would remove" : report.moved_to === undefined ? "removed" : "moved";
  for (const id of report.removed) io.out(`${verb} ${id}`);
  if (report.human_verified.length > 0) {
    io.err(`warning: ${report.human_verified.length} of them had been checked by a person (human_verified): ${report.human_verified.join(", ")}`);
  }
  if (report.unreadable.length > 0) {
    io.err(`warning: ${report.unreadable.length} could not be read; their files ${report.dry_run ? "would go" : "went"}, and the index ${report.dry_run ? "would be" : "was"} rebuilt: ${report.unreadable.join(", ")}`);
  }
  const parts: string[] = [];
  if (report.removed.length > 0) parts.push(`${formatCount(report.removed.length)} record(s)`);
  if (report.blobs_removed.length > 0 || report.removed.length === 0) {
    parts.push(`${formatCount(report.blobs_removed.length)} archived document(s) (${formatBytes(report.blob_bytes)})`);
  }
  const shared = report.blobs_shared > 0 ? `; ${formatCount(report.blobs_shared)} document(s) kept, since records that stay refer to them` : "";
  const where = report.moved_to === undefined ? "" : ` to ${sanitizeForTerminal(report.moved_to)}`;
  io.out(`${report.dry_run ? "Would remove" : report.moved_to === undefined ? "Removed" : "Moved"} ${parts.join(" and ")}${where}${shared}.`);
  if (report.dry_run) io.out("Nothing was changed (--dry-run).");
  else if (report.moved_to !== undefined && report.removed.length > 0) {
    io.out("To undo: move the files back into the corpus and run `ka reindex`.");
  }
}
