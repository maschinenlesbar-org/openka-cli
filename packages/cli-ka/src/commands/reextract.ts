// `ka reextract` — bring stored records up to this build's extractor from their
// archived bytes, without the network (issue #13). The rules and the writing are
// lib-verify's `reextractRecords`; this picks the records and renders the report.

import type { Command } from "commander";
import { OpenKaError, StoreError, UsageError } from "@maschinenlesbar.org/openka-lib-errors";
import { selectRecords } from "@maschinenlesbar.org/openka-lib-search";
import { reextractRecords, type ReextractReport } from "@maschinenlesbar.org/openka-lib-verify";
import { OCR_MODES, createPerceiver, type OcrMode } from "@maschinenlesbar.org/openka-lib-perceive";
import { logOf, type CliDeps, type CliIO } from "../io.js";
import type { Logger } from "../log.js";
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
      const log = logOf(ctx.deps);
      const report = await reextractRecords({
        store: ctx.existingStore(),
        env: ctx.deps.env,
        ids,
        ...(perceiver === undefined ? {} : { perceiver }),
        ...(ctx.opts["force"] === true ? { force: true } : {}),
        ...(ctx.opts["dryRun"] === true ? { dryRun: true } : {}),
        ...(ctx.global.quiet === true || ids.length <= PROGRESS_EVERY
          ? {}
          : { onProgress: (done: number, total: number) => (done % PROGRESS_EVERY === 0 || done === total ? log.info("reextract", `${formatCount(done)}/${formatCount(total)}`) : undefined) }),
      });
      if (ctx.opts["json"] === true) printJson(ctx, report);
      else printReport(io, log, report);
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

/** A list for one line: the first 12, and how many more. */
function list(items: readonly string[]): string {
  return items.length <= 12 ? items.join(", ") : `${items.slice(0, 12).join(", ")} and ${items.length - 12} more`;
}

function printReport(io: CliIO, log: Logger, report: ReextractReport): void {
  for (const result of report.results) {
    if (result.movedTo !== undefined) {
      io.out(
        result.duplicate === true
          ? `${report.dryRun ? "WOULD REMOVE" : "REMOVED"} ${result.id}: a copy an earlier build stored of ${result.movedTo}, which is in the corpus`
          : `${report.dryRun ? "WOULD MOVE" : "MOVED"} ${result.id} → ${result.movedTo}: an earlier build gave it the id of another paper`,
      );
      if (result.duplicate === true) continue;
    }
    if (result.outcome === "changed") {
      const shown = result.differences.slice(0, 8).join(", ");
      const more = result.differences.length > 8 ? `, and ${result.differences.length - 8} more` : "";
      io.out(`CHANGED ${result.id}: ${shown}${more}`);
      if (result.qa !== undefined) {
        const { before, after, gained, lost } = result.qa;
        io.out(`  Q/A: ${before.pairs} → ${after.pairs} pairs, ${before.questions} → ${after.questions} questions, ${before.answers} → ${after.answers} answers`);
        if (gained.length > 0) io.out(`  read now, by number: ${list(gained)}`);
        if (lost.length > 0) io.out(`  no longer read, by number: ${list(lost)}`);
      }
      if (result.resolved.length > 0) io.out(`  newly complete: ${result.resolved.join(", ")}`);
      if (result.abstained.length > 0) io.out(`  newly abstained: ${result.abstained.join(", ")}`);
      if (result.droppedMark === true) io.out("  the human_verified mark was dropped — check it again (`ka review --mark-verified`)");
    } else if (result.outcome === "unreadable" || result.outcome === "unchecked") {
      log.warn("reextract", `skipped ${result.id}: ${result.reason ?? result.outcome}`);
    }
  }
  const c = report.counts;
  const changed = report.results.filter((result) => result.outcome === "changed");
  const complete = changed.filter((result) => result.resolved.length > 0).length;
  const abstained = changed.filter((result) => result.abstained.length > 0).length;
  const left = c.unreadable + c.unchecked + c.duplicate;
  io.out(
    `${report.dryRun ? "Would re-extract" : "Re-extracted"} ${formatCount(report.checked - c.current - left)} of ${formatCount(report.checked)} record(s) ` +
      `with ${report.currentVersion}: ${formatCount(c["unchanged-content"])} only restamped (content identical), ` +
      `${formatCount(c.changed)} changed (${formatCount(complete)} newly complete, ${formatCount(abstained)} newly abstained)` +
      (c.identical > 0 ? `, ${formatCount(c.identical)} identical` : "") +
      `; ${formatCount(c.current)} already current${c.unreadable + c.unchecked > 0 ? `, ${formatCount(c.unreadable + c.unchecked)} skipped` : ""}` +
      `${c.duplicate > 0 ? `, ${formatCount(c.duplicate)} stale copies ${report.dryRun ? "to remove" : "removed"}` : ""}.`,
  );
  // What reads fewer answers or questions than before is what to check against its PDF.
  const fewer = changed.filter((result) => result.qa !== undefined && (result.qa.after.answers < result.qa.before.answers || result.qa.after.questions < result.qa.before.questions));
  if (fewer.length > 0) {
    io.out(`${formatCount(fewer.length)} record(s) read fewer answers or questions than before: ${list(fewer.map((result) => result.id))}`);
  }
  if (report.moved > 0) {
    io.out(`${formatCount(report.moved)} record(s) ${report.dryRun ? "would move" : "moved"} to the id this build gives them (a stale copy is removed where that id is taken).`);
  }
  if (report.dryRun) io.out("Nothing was written (--dry-run).");
  else if (report.reindexed) io.out(`Wrote ${formatCount(report.written)} record(s) and rebuilt the index and catalog.`);
}
