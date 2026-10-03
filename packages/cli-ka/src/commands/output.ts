// `export`, `feed` and `schema` — getting the corpus out in bulk.

import type { Command } from "commander";
import { OpenKaError } from "@maschinenlesbar.org/openka-lib-errors";
import { RECORD_JSON_SCHEMA } from "@maschinenlesbar.org/openka-lib-models";
import { canonicalJsonLine } from "@maschinenlesbar.org/openka-lib-repro";
import { corpusStats } from "@maschinenlesbar.org/openka-lib-store";
import { selectRecords, type Selection } from "@maschinenlesbar.org/openka-lib-search";
import { DEFAULT_FEED_ID, DEFAULT_FEED_TITLE, csvHeader, renderAtom, renderCsvRow, renderJsonLd } from "@maschinenlesbar.org/openka-lib-render";
import { isoInstant } from "@maschinenlesbar.org/openka-lib-pipeline";
import type { CliDeps } from "../io.js";
import {
  action,
  addCorpusFilters,
  addOutOptions,
  choiceOption,
  corpusFiltersFrom,
  emit,
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

export function registerOutput(program: Command, deps: CliDeps): void {
  const exportCommand = addSelectionOptions(
    program
      .command("export")
      .description("export the corpus (or a selection of it) in bulk")
      .addOption(choiceOption("--format <format>", "output format", EXPORT_FORMATS))
      .option("--limit <n>", "maximum records to export (most relevant first with --query)", parseBoundedInt(1, 1_000_000)),
  );
  addOutOptions(exportCommand).action(
    action(deps, async (ctx) => {
      const out = outTarget(ctx);
      const format = (ctx.opts["format"] as (typeof EXPORT_FORMATS)[number] | undefined) ?? "csv";
      const { records } = selection(ctx, ctx.opts["limit"] as number | undefined);
      if (records.length === 0) throw new OpenKaError("Nothing selected — the corpus is empty or the filters match nothing.");

      let text: string;
      if (format === "csv") text = [csvHeader(), ...records.map(renderCsvRow)].join("\n") + "\n";
      else if (format === "jsonl") text = records.map((record) => canonicalJsonLine(record).replace(/\n+$/, "")).join("\n") + "\n";
      else text = records.map((record) => renderJsonLd(record).replace(/\n+$/, "")).join("\n") + "\n";

      emit(ctx, text, out);
      if (out !== undefined) ctx.deps.io.err(`${records.length} record(s) exported.`);
    }),
  );

  const feedCommand = addSelectionOptions(
    program
      .command("feed")
      .description("an Atom feed of the newest matching Anfragen")
      .option("--limit <n>", "entries in the feed", parseBoundedInt(1, 500))
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

  program
    .command("stats")
    .description("what is in this corpus, and how much of it is complete")
    .option("--json", "print as JSON")
    .action(
      action(deps, async (ctx) => {
        const summary = { corpus: ctx.corpusRoot(), ...corpusStats(ctx.existingStore()) };
        if (ctx.opts["json"] === true) {
          printJson(ctx, summary);
          return;
        }
        const io = ctx.deps.io;
        io.out(`${summary.records} record(s) in ${summary.corpus}`);
        if (summary.records === 0) {
          io.out("Nothing synced yet. Try: ka sync --source berlin --since 2024-01-01 --limit 20");
          return;
        }
        const rate = ((summary.parse_complete / summary.records) * 100).toFixed(1);
        io.out(`${summary.parse_complete} parse-complete (${rate}%), ${summary.needs_review} with abstained fields`);
        for (const [parliament, bucket] of Object.entries(summary.by_parliament)) {
          io.out(`  ${parliament}: ${bucket.records} record(s), ${bucket.abstained} needing review`);
        }
      }),
    );
}
