// `export`, `feed` and `schema` — getting the corpus out in bulk.

import type { Command } from "commander";
import { OpenKaError } from "../../core/errors.js";
import { RECORD_JSON_SCHEMA } from "../../core/models/json-schema.js";
import { canonicalJsonLine } from "../../core/repro/canonical.js";
import { search, type SearchFilters } from "../../core/search/search.js";
import { atomEntryUpdated, csvHeader, renderAtom, renderCsvRow, renderJsonLd } from "../../core/render/render.js";
import { isoInstant } from "../../core/pipeline/pipeline.js";
import { ParliamentKeys } from "../../core/models/parliaments.js";
import type { KaRecord } from "../../core/models/schema.js";
import type { CliDeps } from "../io.js";
import { action, choiceOption, collect, collectInt, emit, parseBoundedInt, parseIsoDate, parseNonEmpty, printJson } from "../shared.js";

const EXPORT_FORMATS = ["csv", "jsonl", "jsonld"] as const;

function filtersFrom(opts: Record<string, unknown>): SearchFilters {
  const filters: SearchFilters = {};
  if (opts["parliament"] !== undefined) filters.parliament = opts["parliament"] as string[];
  if (opts["party"] !== undefined) filters.party = opts["party"] as string[];
  if (opts["year"] !== undefined) filters.year = opts["year"] as number[];
  if (opts["period"] !== undefined) filters.period = opts["period"] as number[];
  if (opts["from"] !== undefined) filters.from = opts["from"] as string;
  if (opts["to"] !== undefined) filters.to = opts["to"] as string;
  return filters;
}

function addSelectionOptions(command: Command): Command {
  return command
    .option("--parliament <key>", `restrict to a parliament (repeatable; ${ParliamentKeys.length} known)`, collect)
    .option("--party <name>", "restrict to a party (repeatable)", collect)
    .option("--year <yyyy>", "restrict to a year (repeatable)", collectInt(1949, 2999))
    .option("--period <n>", "restrict to a legislative period (repeatable)", collectInt(1, 99))
    .option("--from <date>", "answered (or submitted) on or after this date", parseIsoDate)
    .option("--to <date>", "answered (or submitted) on or before this date", parseIsoDate)
    .option("--query <terms>", "restrict to records matching these search terms", parseNonEmpty);
}

/** Pull the selected records out of the corpus, ordered by id. */
function selectRecords(
  store: ReturnType<CliDeps["createStore"]>,
  opts: Record<string, unknown>,
  limit: number,
): KaRecord[] {
  const result = search(store, (opts["query"] as string | undefined) ?? "", { ...filtersFrom(opts), limit });
  const records: KaRecord[] = [];
  for (const hit of result.hits) {
    const record = store.getRecord(hit.entry.id);
    if (record !== undefined) records.push(record);
  }
  return records;
}

export function registerOutput(program: Command, deps: CliDeps): void {
  addSelectionOptions(
    program
      .command("export")
      .description("export the corpus (or a selection of it) in bulk")
      .addOption(choiceOption("--format <format>", "output format", EXPORT_FORMATS))
      .option("--limit <n>", "maximum records to export", parseBoundedInt(1, 1_000_000))
      .option("-o, --out <file>", "write to this file instead of stdout", parseNonEmpty),
  ).action(
    action(deps, async (ctx) => {
      const format = (ctx.opts["format"] as (typeof EXPORT_FORMATS)[number] | undefined) ?? "csv";
      const records = selectRecords(ctx.store(), ctx.opts, (ctx.opts["limit"] as number | undefined) ?? 1_000_000);
      if (records.length === 0) throw new OpenKaError("Nothing selected — the corpus is empty or the filters match nothing.");

      let text: string;
      if (format === "csv") text = [csvHeader(), ...records.map(renderCsvRow)].join("\n") + "\n";
      else if (format === "jsonl") text = records.map((record) => canonicalJsonLine(record).replace(/\n+$/, "")).join("\n") + "\n";
      else text = records.map((record) => renderJsonLd(record).replace(/\n+$/, "")).join("\n") + "\n";

      emit(ctx, text, ctx.opts["out"] as string | undefined);
      if (ctx.opts["out"] !== undefined) ctx.deps.io.err(`${records.length} record(s) exported.`);
    }),
  );

  addSelectionOptions(
    program
      .command("feed")
      .description("an Atom feed of the newest matching Anfragen")
      .option("--limit <n>", "entries in the feed", parseBoundedInt(1, 500))
      .option("--title <text>", "feed title", parseNonEmpty)
      .option("--id <url>", "feed id / self link", parseNonEmpty)
      .option("-o, --out <file>", "write to this file instead of stdout", parseNonEmpty),
  ).action(
    action(deps, async (ctx) => {
      const limit = (ctx.opts["limit"] as number | undefined) ?? 50;
      const updated = isoInstant(ctx.deps.now());
      // Order on exactly the instant each entry will print, so "newest first" is
      // true of the feed a reader sees rather than only of the dates. Plain string
      // comparison, not localeCompare: these are ISO instants, and the ordering of
      // a published feed must not depend on the locale of the machine that built it.
      const records = selectRecords(ctx.store(), ctx.opts, 100_000)
        .sort((a, b) => {
          const left = atomEntryUpdated(a, updated);
          const right = atomEntryUpdated(b, updated);
          if (left !== right) return left < right ? 1 : -1;
          return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        })
        .slice(0, limit);
      if (records.length === 0) throw new OpenKaError("Nothing selected — no feed to build.");

      const text = renderAtom(records, {
        title: (ctx.opts["title"] as string | undefined) ?? "OpenKA — Kleine Anfragen",
        id: (ctx.opts["id"] as string | undefined) ?? "urn:openka:feed",
        updated,
      });
      emit(ctx, text, ctx.opts["out"] as string | undefined);
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
        const store = ctx.store();
        const catalog = store.catalog();
        const byParliament = new Map<string, { records: number; abstained: number }>();
        const byTier = new Map<string, number>();
        for (const entry of catalog) {
          const bucket = byParliament.get(entry.parliament) ?? { records: 0, abstained: 0 };
          bucket.records++;
          if (entry.abstained > 0) bucket.abstained++;
          byParliament.set(entry.parliament, bucket);
          byTier.set(entry.tier, (byTier.get(entry.tier) ?? 0) + 1);
        }
        const complete = catalog.filter((entry) => entry.abstained === 0).length;
        const summary = {
          corpus: ctx.corpusRoot(),
          records: catalog.length,
          parse_complete: complete,
          needs_review: catalog.length - complete,
          by_parliament: Object.fromEntries([...byParliament].sort(([a], [b]) => (a < b ? -1 : 1))),
          by_tier: Object.fromEntries([...byTier].sort(([a], [b]) => (a < b ? -1 : 1))),
        };
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
        const rate = ((complete / summary.records) * 100).toFixed(1);
        io.out(`${complete} parse-complete (${rate}%), ${summary.needs_review} with abstained fields`);
        for (const [parliament, bucket] of [...byParliament].sort(([a], [b]) => (a < b ? -1 : 1))) {
          io.out(`  ${parliament}: ${bucket.records} record(s), ${bucket.abstained} needing review`);
        }
      }),
    );
}
