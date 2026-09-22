// `verify`, `review`, `reindex` and `sources` — the commands that keep the corpus
// honest about itself.

import type { Command } from "commander";
import { OpenKaError } from "../../core/errors.js";
import { verifyRecord } from "../../core/repro/verify.js";
import { reindexAll } from "../../core/store/indexer.js";
import { indexRecord } from "../../core/store/indexer.js";
import { SOURCE_REGISTRY, sourceEntry } from "../../sources/registry.js";
import type { CliDeps } from "../io.js";
import { action, parseBoundedInt, parseNonEmpty, printJson } from "../shared.js";
import { pad, truncate } from "../text.js";
import { buildPerceiver, OCR_MODES, type OcrMode } from "./sync.js";
import { choiceOption } from "../shared.js";

export function registerMaintain(program: Command, deps: CliDeps): void {
  program
    .command("verify")
    .description("re-run an extraction from the archived bytes and assert identical output")
    .argument("[id]", "record id; omit to verify a sample of the corpus")
    .option("--all", "verify every record")
    .option("--limit <n>", "how many records to verify when no id is given", parseBoundedInt(1, 1_000_000))
    .addOption(choiceOption("--ocr <mode>", "OCR engine to use for records produced with one", OCR_MODES))
    .option("--json", "print results as JSON")
    .action(
      action(deps, async (ctx, positionals) => {
        const store = ctx.store();
        const ids =
          positionals[0] !== undefined
            ? [positionals[0]]
            : store.recordIds().slice(0, ctx.opts["all"] === true ? undefined : ((ctx.opts["limit"] as number | undefined) ?? 25));
        if (ids.length === 0) throw new OpenKaError(`No records in ${ctx.corpusRoot()}`);

        const mode = (ctx.opts["ocr"] as OcrMode | undefined) ?? "off";
        const perceiver = mode === "off" ? undefined : await buildPerceiver(mode);

        const results = [];
        for (const id of ids) {
          results.push(
            await verifyRecord(id, { store, ...(perceiver === undefined ? {} : { perceiver }), env: ctx.deps.env }),
          );
        }
        const failed = results.filter((result) => !result.ok);

        if (ctx.opts["json"] === true) {
          printJson(ctx, { checked: results.length, reproduced: results.length - failed.length, results });
        } else {
          for (const result of failed) {
            ctx.deps.io.out(`FAIL ${result.id}: ${result.reason ?? "mismatch"}`);
            for (const path of result.differences.slice(0, 10)) ctx.deps.io.out(`       differs at ${path}`);
            if (result.differences.length > 10) {
              ctx.deps.io.out(`       … and ${result.differences.length - 10} more fields`);
            }
          }
          ctx.deps.io.out(`${results.length - failed.length}/${results.length} record(s) reproduced byte-identically.`);
        }
        if (failed.length > 0) throw new OpenKaError(`${failed.length} record(s) did not reproduce`);
      }),
    );

  program
    .command("review")
    .description("work the abstention queue: records the extractor refused to complete")
    .option("--source <key>", "restrict to one parliament", parseNonEmpty)
    .option("--limit <n>", "how many records to list", parseBoundedInt(1, 10_000))
    .option("--mark-verified <id>", "record that a human checked this record against its source", parseNonEmpty)
    .option("--json", "print the queue as JSON")
    .action(
      action(deps, async (ctx) => {
        const store = ctx.store();

        const mark = ctx.opts["markVerified"] as string | undefined;
        if (mark !== undefined) {
          const record = store.getRecord(mark);
          if (record === undefined) throw new OpenKaError(`No record ${mark} in ${ctx.corpusRoot()}`);
          record.extraction.review_status = "human_verified";
          store.putRecord(record);
          indexRecord(store, record);
          ctx.deps.io.out(`${mark}: marked human_verified.`);
          // Saying this out loud matters: a human decision is the one thing in the
          // corpus that re-extraction cannot reproduce, and `ka verify` knows it.
          ctx.deps.io.err(
            "Note: the record's abstained fields are unchanged — marking it verified records that a " +
              "person checked the holes, not that they were filled.",
          );
          return;
        }

        const parliament = ctx.opts["source"] as string | undefined;
        const limit = (ctx.opts["limit"] as number | undefined) ?? 20;
        const queue = store
          .catalog()
          .filter((entry) => entry.abstained > 0 && entry.review_status !== "human_verified")
          .filter((entry) => parliament === undefined || entry.parliament === parliament)
          .sort((a, b) => b.abstained - a.abstained || (a.id < b.id ? -1 : 1));

        if (ctx.opts["json"] === true) {
          printJson(ctx, { total: queue.length, records: queue.slice(0, limit) });
          return;
        }
        if (queue.length === 0) {
          ctx.deps.io.out("Nothing in the review queue — every stored record extracted completely.");
          return;
        }
        for (const entry of queue.slice(0, limit)) {
          const record = store.getRecord(entry.id);
          ctx.deps.io.out(`${pad(entry.id, 24)} ${pad(String(entry.abstained), 3)} ${truncate(entry.title, 60)}`);
          for (const field of record?.extraction.abstained_fields.slice(0, 5) ?? []) {
            ctx.deps.io.out(`    ${field}`);
          }
        }
        ctx.deps.io.err(
          `${Math.min(limit, queue.length)} of ${queue.length} record(s) with abstentions. ` +
            "Check one against its source with `ka open <id>`, then `ka review --mark-verified <id>`.",
        );
      }),
    );

  program
    .command("reindex")
    .description("rebuild the search index and catalog from the stored records")
    .action(
      action(deps, async (ctx) => {
        const count = reindexAll(ctx.store());
        ctx.deps.io.out(`Reindexed ${count} record(s) in ${ctx.corpusRoot()}.`);
      }),
    );

  const sources = program.command("sources").description("the source map and its health");
  sources
    .command("list", { isDefault: true })
    .description("every parliament, its adapter status and its last sync")
    .option("--json", "print as JSON")
    .action(
      action(deps, async (ctx) => {
        const store = ctx.store();
        const counts = new Map<string, number>();
        for (const entry of store.catalog()) {
          counts.set(entry.parliament, (counts.get(entry.parliament) ?? 0) + 1);
        }
        const rows = SOURCE_REGISTRY.map((entry) => {
          const state = store.getSourceState(entry.key);
          return {
            key: entry.key,
            parliament: entry.parliament,
            label: entry.label,
            status: entry.status,
            // The all-Länder aggregator has no parliament of its own — its
            // `parliament` is a typing default — so counting records under it
            // reported NRW's total twice, once under a row it has nothing to do
            // with. `undefined` says "not a number that means anything here".
            records: entry.spansEveryLand === true ? undefined : (counts.get(entry.parliament) ?? 0),
            last_sync: state.last_sync,
            last_success: state.last_success,
            last_error: state.last_error,
            note: entry.note,
          };
        });
        if (ctx.opts["json"] === true) {
          printJson(ctx, rows);
          return;
        }
        ctx.deps.io.out(`${pad("SOURCE", 26)} ${pad("STATUS", 15)} ${pad("RECORDS", 8)} LAST SYNC`);
        for (const row of rows) {
          const health = row.last_error !== undefined ? "degraded" : row.status;
          ctx.deps.io.out(
            `${pad(row.key, 26)} ${pad(health, 15)} ${pad(row.records === undefined ? "—" : String(row.records), 8)} ${row.last_sync ?? "never"}`,
          );
          if (row.last_error !== undefined) ctx.deps.io.out(`    error: ${truncate(row.last_error, 120)}`);
        }
        ctx.deps.io.err(
          "Sources marked `via_aggregator` have no dedicated adapter; they are reachable through " +
            "`--source parlamentsspiegel`, which yields metadata and PDF links only.",
        );
      }),
    );

  sources
    .command("show")
    .description("what one source does and what is specific about it")
    .argument("<key>", "source key")
    .action(
      action(deps, async (ctx, positionals) => {
        const key = positionals[0] as string;
        const entry = sourceEntry(key);
        if (entry === undefined) throw new OpenKaError(`Unknown source "${key}".`);
        const io = ctx.deps.io;
        io.out(`${entry.key} — ${entry.label}`);
        io.out(`parliament: ${entry.parliament}`);
        io.out(`status:     ${entry.status}`);
        io.out(`note:       ${entry.note}`);
        if (entry.factory !== undefined) {
          const source = entry.factory();
          io.out(`tier:       ${source.tier}`);
          io.out(`homepage:   ${source.homepage}`);
          if (source.apiKeyEnv !== undefined) io.out(`credential: --api-key or ${source.apiKeyEnv}`);
          io.out("");
          io.out(source.notes);
        }
      }),
    );
}
