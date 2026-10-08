// `export`, `feed` and `schema` — getting the corpus out in bulk.

import { InvalidArgumentError, Option, type Command } from "commander";
import { OpenKaError, assertValid } from "@maschinenlesbar.org/openka-lib-errors";
import { RECORD_JSON_SCHEMA } from "@maschinenlesbar.org/openka-lib-models";
import { FileStore, corpusDiskUsage, corpusStats, type CatalogGaps, type CorpusStats, type DiskUsage } from "@maschinenlesbar.org/openka-lib-store";
import {
  LIMIT_MIN,
  STATS_DIMENSIONS,
  selectRecords,
  statsBreakdown,
  statsDimensionsProblem,
  statsSelection,
  type Selection,
  type StatsBreakdown,
  type StatsDimension,
} from "@maschinenlesbar.org/openka-lib-search";
import { extractorVersion } from "@maschinenlesbar.org/openka-lib-repro";
import {
  DEFAULT_FEED_ID,
  DEFAULT_FEED_TITLE,
  csvHeader,
  renderAtom,
  renderCsvRow,
  renderJsonLdDocument,
  renderJsonLines,
} from "@maschinenlesbar.org/openka-lib-render";
import { isoInstant } from "@maschinenlesbar.org/openka-lib-pipeline";
import type { CliDeps } from "../io.js";
import { formatBytes, formatCount, pad, sanitizeForTerminal } from "../text.js";
import {
  action,
  addCorpusFilters,
  addOutOptions,
  choiceOption,
  corpusFiltersFrom,
  emit,
  noteUndated,
  outTarget,
  parseBoundedInt,
  parseNonEmpty,
  printJson,
  type ActionContext,
} from "../shared.js";

const EXPORT_FORMATS = ["csv", "jsonl", "jsonld"] as const;

/** The shared filters plus the free-text selection only the bulk commands offer. */
function addSelectionOptions(command: Command): Command {
  return addCorpusFilters(command).option(
    "--query <terms>",
    "restrict to records matching these search terms",
    parseNonEmpty,
  );
}

/**
 * The selection `export` and `feed` work on: the library's `selectRecords`, with
 * the shared filters and `--query`. Ordered by id without `--query` and by
 * relevance with it, so `export --limit` means "the most relevant N". A catalog row
 * whose record file is gone is reported on stderr rather than dropped silently.
 */
function selection(ctx: ActionContext, limit?: number): Selection {
  const selected = selectRecords(ctx.existingStore(), (ctx.opts["query"] as string | undefined) ?? "", {
    ...corpusFiltersFrom(ctx.opts),
    ...(limit === undefined ? {} : { limit }),
  });
  noteUndated(ctx, selected.undated);
  if (selected.missing.length > 0) {
    const shown = selected.missing.slice(0, 5).join(", ");
    const more = selected.missing.length > 5 ? `, and ${selected.missing.length - 5} more` : "";
    ctx.deps.io.err(
      `Note: ${selected.missing.length} catalog row(s) have no record file and were left out: ${shown}${more}. ` +
        "`ka reindex` rebuilds the catalog from the records.",
    );
  }
  return selected;
}

/** The ids to name in a note: the first five, and how many more. */
function someIds(ids: readonly string[]): string {
  const more = ids.length > 5 ? `, and ${ids.length - 5} more` : "";
  return ids.slice(0, 5).join(", ") + more;
}

/**
 * Say on stderr where the catalog and the record files disagree. Search, stats,
 * export and feed read only the catalog, so a record file it lacks is invisible
 * to all four — what an interrupted sync used to leave behind for good.
 */
export function noteCatalogGaps(ctx: ActionContext, gaps: CatalogGaps): void {
  if (gaps.missingFiles.length > 0) {
    ctx.deps.io.err(
      `Note: ${gaps.missingFiles.length} catalog row(s) have no record file, so they are counted and listed ` +
        `but cannot be read: ${someIds(gaps.missingFiles)}. \`ka reindex\` rebuilds the catalog from the records.`,
    );
  }
  if (gaps.uncatalogued.length > 0) {
    ctx.deps.io.err(
      `Note: ${gaps.uncatalogued.length} record file(s) are not in the catalog, so search, stats and export ` +
        `do not see them: ${someIds(gaps.uncatalogued)}. \`ka reindex\` adds them.`,
    );
  }
}

export function registerOutput(program: Command, deps: CliDeps): void {
  const exportCommand = addSelectionOptions(
    program
      .command("export")
      .description("export the corpus (or a selection of it) in bulk")
      .addOption(choiceOption("--format <format>", "output format", EXPORT_FORMATS))
      .option("--limit <n>", "maximum records to export (most relevant first with --query)", parseBoundedInt(LIMIT_MIN, 1_000_000)),
  );
  addOutOptions(exportCommand).action(
    action(deps, async (ctx) => {
      const out = outTarget(ctx);
      const format = (ctx.opts["format"] as (typeof EXPORT_FORMATS)[number] | undefined) ?? "csv";
      const { records } = selection(ctx, ctx.opts["limit"] as number | undefined);
      if (records.length === 0) throw new OpenKaError("Nothing selected — the corpus is empty or the filters match nothing.");

      let text: string;
      if (format === "csv") text = [csvHeader(), ...records.map(renderCsvRow)].join("\n") + "\n";
      else if (format === "jsonl") text = renderJsonLines(records);
      else text = renderJsonLdDocument(records);

      emit(ctx, text, out);
      if (out !== undefined) ctx.deps.io.err(`${records.length} record(s) exported.`);
    }),
  );

  const feedCommand = addSelectionOptions(
    program
      .command("feed")
      .description("an Atom feed of the newest matching Anfragen")
      .option("--limit <n>", "entries in the feed", parseBoundedInt(LIMIT_MIN, 500))
      .option("--title <text>", `feed title (default: ${DEFAULT_FEED_TITLE})`, parseNonEmpty)
      .option("--id <url>", `feed id / self link (default: ${DEFAULT_FEED_ID})`, parseNonEmpty),
  );
  addOutOptions(feedCommand).action(
    action(deps, async (ctx) => {
      const out = outTarget(ctx);
      const limit = (ctx.opts["limit"] as number | undefined) ?? 50;
      const updated = isoInstant(ctx.deps.now());
      // The whole match set goes in and renderAtom keeps the newest `limit`: a
      // pre-cap in id order would drop the newest record of a large corpus.
      const { records } = selection(ctx);
      if (records.length === 0) throw new OpenKaError("Nothing selected — no feed to build.");

      const text = renderAtom(records, {
        ...(ctx.opts["title"] === undefined ? {} : { title: ctx.opts["title"] as string }),
        ...(ctx.opts["id"] === undefined ? {} : { id: ctx.opts["id"] as string }),
        updated,
        limit,
      });
      emit(ctx, text, out);
    }),
  );

  program
    .command("schema")
    .description("print the JSON Schema of the canonical record")
    .action(
      action(deps, async (ctx) => {
        printJson(ctx, RECORD_JSON_SCHEMA);
      }),
    );

  const stats = program
    .command("stats")
    .description("what is in this corpus: coverage, completeness, extractor versions, disk use, and breakdowns with --by")
    .option(
      "--by <dimension>",
      `break the records down by ${STATS_DIMENSIONS.join(", ")}; twice for a cross-tab (--by party --by year)`,
      collectDimension,
    )
    .option("--no-disk", "leave out what the corpus takes on disk (one stat per file)")
    .addOption(new Option("--disk", "on by default").hideHelp())
    .option("--json", "print as JSON");
  addCorpusFilters(stats).action(
    action(deps, async (ctx) => {
      const store = ctx.existingStore();
      const filters = corpusFiltersFrom(ctx.opts);
      const filtered = Object.keys(filters).length > 0;
      const by = (ctx.opts["by"] as StatsDimension[] | undefined) ?? [];
      if (by.length > 0) assertValid("by", by, statsDimensionsProblem);
      const selection = statsSelection(store.catalog(), filters);
      const counted = corpusStats(store, filtered ? { where: selection.where } : {});
      // On by default (issue #16); `--no-disk` leaves the per-file stats out.
      const disk = ctx.opts["disk"] !== false && store instanceof FileStore ? corpusDiskUsage(store) : undefined;
      const breakdown = by.length === 0 ? undefined : statsBreakdown(selection.entries, by);
      const summary = {
        corpus: ctx.corpusRoot(),
        ...counted,
        ...(disk === undefined ? {} : { disk }),
        ...(breakdown === undefined ? {} : { breakdown }),
      };
      if (ctx.opts["json"] === true) {
        printJson(ctx, summary);
        return;
      }
      const io = ctx.deps.io;
      const total = store.catalog().length;
      io.out(filtered ? `${formatCount(summary.records)} of ${formatCount(total)} record(s) in ${summary.corpus} match the filters` : `${summary.records} record(s) in ${summary.corpus}`);
      if (filtered) noteUndated(ctx, selection.undated);
      noteCatalogGaps(ctx, { uncatalogued: summary.uncatalogued, missingFiles: summary.missing_files });
      if (summary.records === 0 && summary.uncatalogued.length === 0) {
        io.out(filtered ? "No record matches the filters." : "Nothing synced yet. Try: ka sync --source berlin --since 2024-01-01 --limit 20");
        return;
      }
      // No catalogued record (only uncatalogued files, noted above): there is no rate to
      // give — dividing by zero printed "NaN%".
      const rate = summary.records === 0 ? "" : ` (${((summary.parse_complete / summary.records) * 100).toFixed(1)}%)`;
      const knownOnly = (n: number): string => (n === 0 ? "" : ` (${formatCount(n)} only where the parliament never provides the field)`);
      io.out(`${summary.parse_complete} parse-complete${rate}, ${summary.needs_review} with abstained fields${knownOnly(summary.known_gaps_only)}`);
      for (const [parliament, bucket] of Object.entries(summary.by_parliament)) {
        io.out(`  ${parliament}: ${bucket.records} record(s), ${bucket.abstained} needing review${knownOnly(bucket.known_gaps_only)}`);
      }
      printCoverage(ctx, summary);
      printVersions(ctx, summary);
      if (disk !== undefined) {
        const size = (usage: DiskUsage): string => `${formatBytes(usage.bytes)} in ${formatCount(usage.files)} file(s)`;
        const bytes = disk.blobs.bytes + disk.records.bytes + disk.index.bytes;
        io.out(
          `On disk${filtered ? " (the whole corpus)" : ""}: blobs ${size(disk.blobs)}, records ${size(disk.records)}, index ${size(disk.index)}; ` +
            `${formatBytes(bytes)} in all${total === 0 ? "" : `, ${formatBytes(bytes / total)} per Anfrage`}`,
        );
        for (const [source, usage] of Object.entries(disk.by_source)) {
          if (usage.files === 0) continue;
          io.out(`  ${source}: ${formatCount(usage.files)} document(s), ${formatBytes(usage.bytes)} (avg ${formatBytes(usage.bytes / usage.files)})`);
        }
      }
      if (breakdown !== undefined) printBreakdown(ctx, breakdown);
    }),
  );
}

/** commander accumulator for a repeatable `--by`: each one of `STATS_DIMENSIONS`. */
function collectDimension(value: string, previous: StatsDimension[] = []): StatsDimension[] {
  const dimension = STATS_DIMENSIONS.find((known) => known === value);
  if (dimension === undefined) throw new InvalidArgumentError(`Allowed choices are ${STATS_DIMENSIONS.join(", ")}.`);
  return previous.concat([dimension]);
}

/** When the questions were asked, how many there are, how many are answered — and what was abstained on most. */
function printCoverage(ctx: ActionContext, stats: CorpusStats): void {
  const io = ctx.deps.io;
  const c = stats.coverage;
  const span = c.first_asked === undefined ? "no question date known" : `asked ${c.first_asked} to ${c.last_asked ?? c.first_asked}`;
  const undated = c.undated > 0 ? ` (${formatCount(c.undated)} without a question date)` : "";
  const unknown = c.questions_unknown > 0 ? ` (+ ${formatCount(c.questions_unknown)} record(s) not counted yet)` : "";
  io.out(`Coverage: ${span}${undated}; ${formatCount(c.questions)} questions${unknown}; ${formatCount(c.unanswered)} without an answer date`);
  const fields = Object.entries(stats.abstained_by_field).sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1));
  if (fields.length > 0) {
    const shown = fields.slice(0, 5).map(([field, count]) => `${field} ${formatCount(count)}`).join(", ");
    io.out(`Abstained most: ${shown}${fields.length > 5 ? `, … ${fields.length - 5} more` : ""} (\`ka review --group-by field\`)`);
  }
}

/** Which extractor versions made the records; more than one means `ka reextract` is due. */
function printVersions(ctx: ActionContext, stats: CorpusStats): void {
  const io = ctx.deps.io;
  const current = extractorVersion(ctx.deps.env);
  const versions = Object.entries(stats.extractor_versions).sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1));
  const width = Math.max(0, ...versions.map(([version]) => version.length));
  versions.forEach(([version, count], index) => {
    const mark = version === current ? " (this build)" : "";
    io.out(`${index === 0 ? "Extractor:" : "          "} ${pad(version, width)}  ${formatCount(count)} record(s)${mark}`);
  });
  const others = versions.filter(([version]) => version !== current).reduce((sum, [, count]) => sum + count, 0);
  if (others > 0) io.out(`  ${formatCount(others)} record(s) were made by another build — \`ka reextract --all\` brings them to this one.`);
  const notIndexed = stats.extractor_versions_unknown + 0;
  if (notIndexed > 0) {
    io.err(`Note: ${formatCount(notIndexed)} catalog row(s) predate the version, ministry and question counts; \`ka reindex\` adds them.`);
  }
}

function printBreakdown(ctx: ActionContext, breakdown: StatsBreakdown): void {
  const io = ctx.deps.io;
  const widths = breakdown.by.map((dimension, index) =>
    Math.max(dimension.length, ...breakdown.rows.map((row) => String(row.keys[index]).length)),
  );
  const head = breakdown.by.map((dimension, index) => pad(dimension.toUpperCase(), widths[index] ?? 0)).join("  ");
  io.out("");
  io.out(`${head}  ${"RECORDS".padStart(9)}  NEEDS REVIEW`);
  for (const row of breakdown.rows) {
    const keys = row.keys.map((key, index) => pad(sanitizeForTerminal(String(key)), widths[index] ?? 0)).join("  ");
    const share = row.records === 0 ? "" : ` (${Math.round((row.needs_review / row.records) * 100)}%)`;
    io.out(`${keys}  ${formatCount(row.records).padStart(9)}  ${formatCount(row.needs_review)}${share}`);
  }
  if (breakdown.overlapping) io.err("Note: a record asked by several parties counts for each, so the rows add up to more than the records.");
}
