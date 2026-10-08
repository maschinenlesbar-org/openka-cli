// `verify`, `review`, `reindex` and `sources` — the commands that keep the corpus
// honest about itself.

import type { Command } from "commander";
import { OpenKaError, StoreError, UsageError } from "@maschinenlesbar.org/openka-lib-errors";
import { DEFAULT_VERIFY_SAMPLE, assertVerified, verifyCorpus } from "@maschinenlesbar.org/openka-lib-verify";
import { catalogGaps, reindexAll } from "@maschinenlesbar.org/openka-lib-store";
import { noteCatalogGaps } from "./output.js";
import { markHumanVerified } from "@maschinenlesbar.org/openka-lib-store";
import { countSources, sourceStatus } from "@maschinenlesbar.org/openka-lib-pipeline";
import { DEFAULT_REVIEW_LIMIT, LIMIT_MIN, reviewGroups, reviewQueue } from "@maschinenlesbar.org/openka-lib-search";
import { SOURCE_REGISTRY, createSource, sourceEntry, sourceKeyProblem } from "@maschinenlesbar.org/openka-lib-registry";
import { HostPacer } from "@maschinenlesbar.org/openka-lib-http";
import { PERIOD_RANGE } from "@maschinenlesbar.org/openka-lib-models";
import type { CliDeps } from "../io.js";
import { action, apiKeyLookup, parseBoundedInt, parseNonEmpty, parseParliament, parseRecordId, printJson, problemParser, toEngineOptions } from "../shared.js";
import { formatCount, pad, truncate } from "../text.js";
import { OCR_MODES, createPerceiver, type OcrMode } from "@maschinenlesbar.org/openka-lib-perceive";
import { choiceOption } from "../shared.js";

export function registerMaintain(program: Command, deps: CliDeps): void {
  program
    .command("verify")
    .description("re-run an extraction from the archived bytes and assert identical output")
    .argument("[id]", "record id; omit to verify an evenly spaced sample of the corpus", parseRecordId)
    .option("--all", "verify every record")
    .option("--limit <n>", `how many records to verify when no id is given (default: ${DEFAULT_VERIFY_SAMPLE})`, parseBoundedInt(1, 1_000_000))
    .addOption(choiceOption("--ocr <mode>", "OCR engine to use for records produced with one", OCR_MODES))
    .option("--json", "print results as JSON")
    .action(
      action(deps, async (ctx, positionals) => {
        const store = ctx.existingStore();
        const mode = (ctx.opts["ocr"] as OcrMode | undefined) ?? "off";
        const perceiver = mode === "off" ? undefined : await createPerceiver(mode);
        // Which records, the corrupt-record rows, "no records" and the verdict
        // are the library's (verifyCorpus, assertVerified); this only renders.
        const report = await verifyCorpus({
          store,
          env: ctx.deps.env,
          ...(perceiver === undefined ? {} : { perceiver }),
          ...(positionals[0] !== undefined
            ? { ids: [positionals[0]] }
            : ctx.opts["all"] === true
              ? { all: true }
              : ctx.opts["limit"] === undefined
                ? {}
                : { limit: ctx.opts["limit"] as number }),
        });

        if (ctx.opts["json"] === true) {
          printJson(ctx, report);
        } else {
          const io = ctx.deps.io;
          const versionOnly = report.results.filter((result) => result.verdict === "version-only");
          for (const result of report.results.filter((result) => !result.ok && result.verdict !== "version-only")) {
            if (result.verdict === "differs" && result.storedVersion !== result.currentVersion) {
              // Stamped by another build, and the content moved too: what moved is the
              // finding, the version only the context.
              const shown = result.contentDifferences.slice(0, 10).join(", ");
              const more = result.contentDifferences.length > 10 ? `, and ${result.contentDifferences.length - 10} more` : "";
              io.out(`DIFF ${result.id}: content differs at ${shown}${more} (produced by ${result.storedVersion}, this build is ${result.currentVersion})`);
              continue;
            }
            io.out(`FAIL ${result.id}: ${result.reason ?? "mismatch"}`);
            for (const path of result.differences.slice(0, 10)) io.out(`       differs at ${path}`);
            if (result.differences.length > 10) io.out(`       … and ${result.differences.length - 10} more fields`);
          }
          // After an upgrade that is every record: a few named, the rest counted.
          for (const result of versionOnly.slice(0, 10)) io.out(`VERSION ${result.id}: ${result.reason ?? ""}`);
          if (versionOnly.length > 10) io.out(`VERSION … and ${versionOnly.length - 10} more`);
          io.out(
            `${report.reproduced}/${report.checked} record(s) reproduced byte-identically.` +
              (report.versionOnly > 0
                ? ` ${report.versionOnly} more reproduce in content but carry another extractor version — \`ka reextract\` restamps them.`
                : "") +
              (report.differs > 0 ? ` ${report.differs} differ in content.` : ""),
          );
          // Without this the tally vouched for an edited asker or title, which
          // re-extraction takes from the record itself (UNCHECKED_FIELDS).
          ctx.deps.io.err(
            "Note: verify re-derives the text, the Q/A pairs, the markers and the extraction stamp from the archived " +
              "documents. Title, askers, answered_by, dates and the documents' URLs come from the record itself and " +
              "are not checked against anything archived.",
          );
        }
        // `verify` reads the record files, search the catalog: say where they differ.
        noteCatalogGaps(ctx, catalogGaps(store));
        assertVerified(report);
      }),
    );

  program
    .command("review")
    .description("work the abstention queue: records the extractor refused to complete")
    .option("--source <key>", "restrict to one parliament", parseParliament)
    .option("--limit <n>", `how many records to list (default: ${DEFAULT_REVIEW_LIMIT})`, parseBoundedInt(LIMIT_MIN, 10_000))
    .option("--mark-verified <id>", "record that a human checked this record against its source", parseRecordId)
    .addOption(choiceOption("--group-by <what>", "summarise the queue per source by the kind of field abstained on, with example ids", ["field"]))
    .option("--json", "print the queue as JSON")
    .action(
      action(deps, async (ctx) => {
        const store = ctx.existingStore();
        if (ctx.opts["groupBy"] !== undefined) {
          for (const [key, flag] of [["markVerified", "--mark-verified"], ["limit", "--limit"]] as const) {
            if (ctx.opts[key] !== undefined) throw new UsageError(`${flag} does not apply to --group-by, which summarises the whole queue.`);
          }
          const parliament = ctx.opts["source"] as string | undefined;
          const grouped = reviewGroups(store, parliament === undefined ? {} : { parliament });
          if (ctx.opts["json"] === true) {
            printJson(ctx, grouped);
            return;
          }
          const io = ctx.deps.io;
          if (grouped.length === 0) {
            io.out("Nothing in the review queue.");
            return;
          }
          for (const set of grouped) {
            io.out(`${set.parliament}: ${formatCount(set.queued)} record(s) in the queue`);
            if (set.groups.length > 0) io.out(`  ${pad("FIELD", 22)} ${"OCCURRENCES".padStart(11)} ${"RECORDS".padStart(8)}  EXAMPLES`);
            for (const group of set.groups) {
              io.out(
                `  ${pad(group.field, 22)} ${formatCount(group.occurrences).padStart(11)} ${formatCount(group.records).padStart(8)}  ${group.examples.join(", ")}`,
              );
            }
            if (set.unknown > 0) {
              io.err(`note: ${set.parliament}: ${set.unknown} record(s) were catalogued before abstained fields were indexed; \`ka reindex\` adds them.`);
            }
          }
          return;
        }

        const mark = ctx.opts["markVerified"] as string | undefined;
        if (mark !== undefined) {
          if (markHumanVerified(store, mark) === undefined) throw new OpenKaError(`No record ${mark} in ${ctx.corpusRoot()}`);
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
        const limit = ctx.opts["limit"] as number | undefined;
        const queue = reviewQueue(store, {
          ...(parliament === undefined ? {} : { parliament }),
          ...(limit === undefined ? {} : { limit }),
        });

        if (ctx.opts["json"] === true) {
          printJson(ctx, { total: queue.total, records: queue.entries });
          return;
        }
        if (queue.total === 0) {
          // A verified record left the queue with its holes: "extracted completely"
          // would claim something nobody did.
          ctx.deps.io.out(
            queue.verified === 0
              ? "Nothing in the review queue — every stored record extracted completely."
              : `Nothing left to review — ${queue.verified} record(s) with abstained fields were checked by a ` +
                  "person (human_verified); their holes stay, see `ka search --needs-review`.",
          );
          return;
        }
        for (const entry of queue.entries) {
          const record = store.getRecord(entry.id);
          ctx.deps.io.out(`${pad(entry.id, 24)} ${pad(String(entry.abstained), 3)} ${truncate(entry.title, 60)}`);
          for (const field of record?.extraction.abstained_fields.slice(0, 5) ?? []) {
            ctx.deps.io.out(`    ${field}`);
          }
        }
        ctx.deps.io.err(
          `${queue.entries.length} of ${queue.total} record(s) with abstentions. ` +
            "Check one against its source with `ka open <id>`, then `ka review --mark-verified <id>`.",
        );
      }),
    );

  program
    .command("reindex")
    .description("rebuild the search index and catalog from the stored records")
    .action(
      action(deps, async (ctx) => {
        const unreadable: string[] = [];
        const count = reindexAll(ctx.existingStore(), {
          onUnreadable: (id, err) => {
            unreadable.push(id);
            ctx.deps.io.err(`skipped ${id}: ${err.message}`);
          },
        });
        ctx.deps.io.out(`Reindexed ${count} record(s) in ${ctx.corpusRoot()}.`);
        // The rest of the corpus is searchable again; the unreadable ones are not,
        // and saying so is a corpus problem, not a success.
        if (unreadable.length > 0) {
          throw new StoreError(`${unreadable.length} unreadable record(s) left out of the index: ${unreadable.join(", ")}`);
        }
      }),
    );

  const sources = program.command("sources").description("the source map and its health");
  sources
    .command("list", { isDefault: true })
    .description("every parliament, its adapter status and its last sync")
    .option("--json", "print as JSON")
    .action(
      action(deps, async (ctx) => {
        const rows = sourceStatus(ctx.store(), SOURCE_REGISTRY);
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
    .command("count")
    .description("how many Anfragen each upstream holds, beside how many the corpus has — a request or two per source, no download")
    .option("--source <key>", "count only this source (repeatable; default: every parliament)", collectSourceKey)
    .option("--period <n>", "count one legislative period (DIP can; the Parlamentsspiegel cannot)", parseBoundedInt(...PERIOD_RANGE))
    .option("--api-key <key>", "credential for sources that need one (overrides the env var)", parseNonEmpty)
    .option("--json", "print as JSON")
    .action(
      action(deps, async (ctx) => {
        const keys =
          (ctx.opts["source"] as string[] | undefined) ??
          SOURCE_REGISTRY.filter((entry) => entry.parliament !== undefined && entry.factory !== undefined).map((entry) => entry.key);
        const sourcesToCount = keys.map((key) => createSource(key));
        const pacer = new HostPacer();
        if (ctx.global.quiet !== true && ctx.opts["json"] !== true) {
          ctx.deps.io.err(`Asking ${sourcesToCount.length} upstream(s) for their count…`);
        }
        const rows = await countSources({
          sources: sourcesToCount,
          store: ctx.store(),
          engineFor: () => ctx.deps.createEngine({ ...toEngineOptions(ctx.global), pacer }),
          apiKeyFor: apiKeyLookup(ctx),
          ...(ctx.opts["period"] === undefined ? {} : { period: ctx.opts["period"] as number }),
        });
        // Named on its own, a source that could not be counted is the command's
        // error; in the table of all of them it is a note on its row.
        const only = rows.length === 1 ? rows[0] : undefined;
        if (only !== undefined && only.upstream === undefined) {
          throw only.error ?? new OpenKaError(`${only.source}: ${only.note ?? "no count"}`);
        }
        if (ctx.opts["json"] === true) {
          printJson(ctx, rows.map(({ error: _error, ...row }) => row));
          return;
        }
        const io = ctx.deps.io;
        const num = (n: number | undefined): string => (n === undefined ? "—" : formatCount(n));
        const line = (source: string, upstream: string, inCorpus: string, missing: string, basis: string): string =>
          `${pad(source, 24)} ${upstream.padStart(9)} ${inCorpus.padStart(10)} ${missing.padStart(9)}  ${basis}`.trimEnd();
        io.out(line("SOURCE", "UPSTREAM", "IN CORPUS", "MISSING", "BASIS"));
        for (const row of rows) {
          io.out(line(row.source, num(row.upstream), num(row.in_corpus), num(row.missing), row.basis ?? ""));
        }
        const counted = rows.filter((row) => row.upstream !== undefined && row.parliament !== undefined);
        if (counted.length > 1) {
          const sum = (pick: (row: (typeof counted)[number]) => number): number => counted.reduce((total, row) => total + pick(row), 0);
          io.out(line("total", num(sum((row) => row.upstream ?? 0)), num(sum((row) => row.in_corpus)), num(sum((row) => row.missing ?? 0)), ""));
        }
        for (const row of rows.filter((row) => row.note !== undefined)) io.err(`note: ${row.source}: ${truncate(row.note ?? "", 200)}`);
        if (rows.every((row) => row.upstream === undefined)) throw new OpenKaError("no upstream could be counted");
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
        io.out(`parliament: ${entry.parliament ?? "(every Land that delivers to the portal)"}`);
        io.out(`status:     ${entry.status}`);
        io.out(`note:       ${entry.note}`);
        if (entry.factory !== undefined) {
          const source = entry.factory();
          io.out(`tier:       ${source.tier}`);
          io.out(`homepage:   ${source.homepage}`);
          if (source.apiKeyEnv !== undefined) io.out(`credential: --api-key, ${source.apiKeyEnv} or \`ka config set ${source.key}.api-key\``);
          io.out("");
          io.out(source.notes);
        }
      }),
    );
}

/** commander accumulator for a repeatable `--source`: each a key the registry knows. */
function collectSourceKey(value: string, previous: string[] = []): string[] {
  return previous.concat([problemParser(sourceKeyProblem)(value)]);
}
