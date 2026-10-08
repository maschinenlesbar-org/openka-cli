// `ka reextract` — bring stored records up to this build's extractor from their
// archived bytes, without the network (issue #13). The rules and the writing are
// lib-verify's `reextractRecords`; this picks the records and renders the report.

import type { Command } from "commander";
import { OpenKaError, StoreError, UsageError } from "@maschinenlesbar.org/openka-lib-errors";
import { selectRecords } from "@maschinenlesbar.org/openka-lib-search";
import { reextractRecords, type ReextractReport } from "@maschinenlesbar.org/openka-lib-verify";
import { OCR_MODES, createPerceiver, type OcrMode } from "@maschinenlesbar.org/openka-lib-perceive";
import type { CliDeps, CliIO } from "../io.js";
import { action, addCorpusFilters, choiceOption, corpusFiltersFrom, noteUndated, parseRecordId, printJson, type ActionContext } from "../shared.js";
import { formatCount } from "../text.js";

/** A progress line on stderr every this many records. */
const PROGRESS_EVERY = 100;

export function registerReextract(program: Command, deps: CliDeps): void {
  const command = program
    .command("reextract")
    .description("re-extract stored records from their archived bytes with this build's extractor — no network; then rebuild the index")
    .argument("[ids...]", "record ids; or select with --all or the filters", collectRecordId)
    .option("--all", "every record in the corpus")
    .option("--force", "also the records this build's extractor already stamped")
    .option("--dry-run", "say what would change, and write nothing")
    .addOption(choiceOption("--ocr <mode>", "OCR engine for records produced with one", OCR_MODES))
    .option("--json", "print the report as JSON");
  addCorpusFilters(command).action(
    action(deps, async (ctx, positionals) => {
      const ids = selectIds(ctx, (positionals[0] as unknown as string[] | undefined) ?? []);
      const mode = (ctx.opts["ocr"] as OcrMode | undefined) ?? "off";
      const perceiver = mode === "off" ? undefined : await createPerceiver(mode);
      const io = ctx.deps.io;
      const report = await reextractRecords({
        store: ctx.existingStore(),
        env: ctx.deps.env,
        ids,
        ...(perceiver === undefined ? {} : { perceiver }),
        ...(ctx.opts["force"] === true ? { force: true } : {}),
        ...(ctx.opts["dryRun"] === true ? { dryRun: true } : {}),
        ...(ctx.global.quiet === true || ids.length <= PROGRESS_EVERY
          ? {}
          : { onProgress: (done: number, total: number) => (done % PROGRESS_EVERY === 0 || done === total ? io.err(`reextract: ${formatCount(done)}/${formatCount(total)}`) : undefined) }),
      });
      if (ctx.opts["json"] === true) printJson(ctx, report);
      else printReport(io, report);
      const unchecked = report.counts.unchecked;
      if (report.counts.unreadable > 0) {
        throw new StoreError(`${report.counts.unreadable} record(s) could not be read and were left as they are`);
      }
      if (unchecked > 0) throw new OpenKaError(`${unchecked} record(s) were produced with an OCR model and were left as they are; re-run with --ocr`);
    }),
  );
}

/** commander accumulator for the variadic ids. */
function collectRecordId(value: string, previous: string[] = []): string[] {
  return previous.concat([parseRecordId(value)]);
}

/** The records named: ids, or `--all` / the filters — never both, never neither. */
function selectIds(ctx: ActionContext, ids: string[]): string[] {
  const filters = corpusFiltersFrom(ctx.opts);
  const filtered = Object.keys(filters).length > 0;
  const all = ctx.opts["all"] === true;
  if (ids.length > 0 && (all || filtered)) throw new UsageError("Name records by id, or select them with --all or the filters — not both.");
  if (ids.length > 0) return ids;
  if (!all && !filtered) throw new UsageError("Name the records: ids, --all, or filters such as --parliament berlin --year 2025.");
  const store = ctx.existingStore();
  if (!filtered) return store.recordIds();
  const selected = selectRecords(store, "", filters);
  noteUndated(ctx, selected.undated);
  return selected.records.map((record) => record.id);
}

function printReport(io: CliIO, report: ReextractReport): void {
  for (const result of report.results) {
    if (result.outcome === "changed") {
      const shown = result.differences.slice(0, 8).join(", ");
      const more = result.differences.length > 8 ? `, and ${result.differences.length - 8} more` : "";
      io.out(`CHANGED ${result.id}: ${shown}${more}`);
      if (result.resolved.length > 0) io.out(`  newly complete: ${result.resolved.join(", ")}`);
      if (result.abstained.length > 0) io.out(`  newly abstained: ${result.abstained.join(", ")}`);
      if (result.droppedMark === true) io.out("  the human_verified mark was dropped — check it again (`ka review --mark-verified`)");
    } else if (result.outcome === "unreadable" || result.outcome === "unchecked") {
      io.err(`skipped ${result.id}: ${result.reason ?? result.outcome}`);
    }
  }
  const c = report.counts;
  const changed = report.results.filter((result) => result.outcome === "changed");
  const complete = changed.filter((result) => result.resolved.length > 0).length;
  const abstained = changed.filter((result) => result.abstained.length > 0).length;
  const left = c.unreadable + c.unchecked;
  io.out(
    `${report.dryRun ? "Would re-extract" : "Re-extracted"} ${formatCount(report.checked - c.current - left)} of ${formatCount(report.checked)} record(s) ` +
      `with ${report.currentVersion}: ${formatCount(c["unchanged-content"])} only restamped (content identical), ` +
      `${formatCount(c.changed)} changed (${formatCount(complete)} newly complete, ${formatCount(abstained)} newly abstained)` +
      (c.identical > 0 ? `, ${formatCount(c.identical)} identical` : "") +
      `; ${formatCount(c.current)} already current${left > 0 ? `, ${formatCount(left)} skipped` : ""}.`,
  );
  if (report.dryRun) io.out("Nothing was written (--dry-run).");
  else if (report.reindexed) io.out(`Wrote ${formatCount(report.written)} record(s) and rebuilt the index and catalog.`);
}
