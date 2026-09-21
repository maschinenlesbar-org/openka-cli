// The read side: `search`, `get`, `show` and `open`.

import type { Command } from "commander";
import { OpenKaError } from "../../core/errors.js";
import { parliamentByKey, ParliamentKeys } from "../../core/models/parliaments.js";
import { ReviewStatuses } from "../../core/models/schema.js";
import { search } from "../../core/search/search.js";
import { searchLike } from "../../core/search/semantic.js";
import { RENDER_FORMATS, renderRecord, type RenderFormat } from "../../core/render/render.js";
import type { CatalogEntry } from "../../core/store/store.js";
import type { CliDeps } from "../io.js";
import {
  action,
  choiceOption,
  collect,
  collectInt,
  parseBoundedInt,
  parseIsoDate,
  parseNonEmpty,
  printJson,
} from "../shared.js";
import { pad, sanitizeForTerminal, truncate } from "../text.js";

function addFilterOptions(command: Command): Command {
  return command
    .option("--parliament <key>", `restrict to a parliament (repeatable: ${ParliamentKeys.length} known)`, collect)
    .option("--party <name>", "restrict to Anfragen asked by this party (repeatable)", collect)
    .option("--year <yyyy>", "restrict to a year (repeatable)", collectInt(1949, 2999))
    .option("--period <n>", "restrict to a legislative period (repeatable)", collectInt(1, 99))
    .option("--from <date>", "answered (or submitted) on or after this date", parseIsoDate)
    .option("--to <date>", "answered (or submitted) on or before this date", parseIsoDate)
    .addOption(choiceOption("--review-status <status>", "restrict by review status", ReviewStatuses))
    .option("--needs-review", "only records with at least one abstained field");
}

function filtersFrom(opts: Record<string, unknown>): Record<string, unknown> {
  const filters: Record<string, unknown> = {};
  if (opts["parliament"] !== undefined) filters["parliament"] = opts["parliament"];
  if (opts["party"] !== undefined) filters["party"] = opts["party"];
  if (opts["year"] !== undefined) filters["year"] = opts["year"];
  if (opts["period"] !== undefined) filters["period"] = opts["period"];
  if (opts["from"] !== undefined) filters["from"] = opts["from"];
  if (opts["to"] !== undefined) filters["to"] = opts["to"];
  if (opts["reviewStatus"] !== undefined) filters["reviewStatus"] = [opts["reviewStatus"]];
  if (opts["needsReview"] === true) filters["onlyAbstained"] = true;
  return filters;
}

/** One result line: id, date, parliament, title — and a marker for holes. */
function formatHit(entry: CatalogEntry, score: number, snippet?: string): string {
  const flag = entry.abstained > 0 ? "!" : " ";
  const date = entry.answered ?? entry.submitted ?? "".padEnd(10);
  const line =
    `${flag} ${pad(entry.id, 24)} ${pad(date, 10)} ${pad(truncate(entry.parliament, 14), 14)} ` +
    `${truncate(entry.title, 70)}${score > 0 ? ` (${score.toFixed(2)})` : ""}`;
  return snippet === undefined ? line : `${line}\n      ${truncate(snippet, 150)}`;
}

export function registerQuery(program: Command, deps: CliDeps): void {
  addFilterOptions(
    program
      .command("search")
      .description("full-text search over the corpus")
      .argument("[query]", "search terms; quote a phrase, prefix a term with - to exclude it")
      .option("--limit <n>", "maximum results", parseBoundedInt(1, 1000))
      .option("--offset <n>", "skip this many results", parseBoundedInt(0))
      .option("--snippet", "show a text snippet around the first match")
      .option("--like <id>", "semantic search: records similar to this one (needs frozen embeddings)", parseNonEmpty)
      .option("--json", "print results as JSON"),
  ).action(
    action(deps, async (ctx, positionals) => {
      const store = ctx.store();
      const filters = filtersFrom(ctx.opts);
      const limit = (ctx.opts["limit"] as number | undefined) ?? 20;

      if (ctx.opts["like"] !== undefined) {
        const hits = searchLike(store, ctx.opts["like"] as string, { ...filters, limit });
        if (ctx.opts["json"] === true) {
          printJson(ctx, { total: hits.length, hits });
          return;
        }
        if (hits.length === 0) ctx.deps.io.out("No similar records.");
        for (const hit of hits) ctx.deps.io.out(formatHit(hit.entry, hit.score));
        return;
      }

      const result = search(store, positionals[0] ?? "", {
        ...filters,
        limit,
        offset: (ctx.opts["offset"] as number | undefined) ?? 0,
        snippet: ctx.opts["snippet"] === true,
      });
      if (ctx.opts["json"] === true) {
        printJson(ctx, result);
        return;
      }
      if (result.total === 0) {
        ctx.deps.io.out("No matches.");
        return;
      }
      for (const hit of result.hits) ctx.deps.io.out(formatHit(hit.entry, hit.score, hit.snippet));
      const shown = result.hits.length;
      const offset = (ctx.opts["offset"] as number | undefined) ?? 0;
      ctx.deps.io.err(`${shown} of ${result.total} match(es)${offset > 0 ? `, from offset ${offset}` : ""}.`);
    }),
  );

  program
    .command("get")
    .description("print one record in a machine-readable format")
    .argument("<id>", "record id, e.g. berlin-19-10006")
    .addOption(choiceOption("--format <format>", "output format", RENDER_FORMATS))
    .option("-o, --out <file>", "write to this file instead of stdout", parseNonEmpty)
    .action(
      action(deps, async (ctx, positionals) => {
        const id = positionals[0] as string;
        const record = ctx.store().getRecord(id);
        if (record === undefined) throw new OpenKaError(`No record ${id} in ${ctx.corpusRoot()}`);
        const format = ((ctx.opts["format"] as RenderFormat | undefined) ?? "json") as RenderFormat;
        const text = renderRecord(record, format);
        const out = ctx.opts["out"] as string | undefined;
        if (out === undefined) ctx.deps.io.out(text.replace(/\n$/, ""));
        else {
          const data = Buffer.from(text, "utf8");
          ctx.deps.io.writeFile(out, data);
          ctx.deps.io.err(`Wrote ${data.length} bytes to ${out}`);
        }
      }),
    );

  program
    .command("show")
    .description("render one record for reading")
    .argument("<id>", "record id")
    .action(
      action(deps, async (ctx, positionals) => {
        const id = positionals[0] as string;
        const record = ctx.store().getRecord(id);
        if (record === undefined) throw new OpenKaError(`No record ${id} in ${ctx.corpusRoot()}`);
        const parliament = parliamentByKey(record.parliament);
        const io = ctx.deps.io;
        io.out(sanitizeForTerminal(record.title || "(no title)"));
        io.out(
          `${parliament?.label ?? record.parliament} · Drucksache ${record.reference} · WP ${record.legislative_period}`,
        );
        const askers = record.askers
          .map((asker) => (asker.party === undefined ? asker.name : `${asker.name} (${asker.party})`))
          .join(", ");
        if (askers !== "") io.out(`Gefragt von: ${sanitizeForTerminal(askers)}`);
        if (record.answered_by.ministry !== undefined) {
          io.out(`Beantwortet von: ${sanitizeForTerminal(record.answered_by.ministry)}`);
        }
        io.out(
          [
            record.dates.submitted === undefined ? undefined : `eingereicht ${record.dates.submitted}`,
            record.dates.answered === undefined ? undefined : `beantwortet ${record.dates.answered}`,
          ]
            .filter(Boolean)
            .join(" · "),
        );
        io.out("");
        if (record.markers.classified) io.out("[ als Verschlusssache gekennzeichnet ]");
        if (record.markers.attachments_referenced.length > 0) {
          io.out(`[ Anlagen: ${record.markers.attachments_referenced.join(", ")} ]`);
        }
        if (record.qa.length === 0) io.out("(no question/answer pairs were extracted)");
        for (const pair of record.qa) {
          io.out(`Frage ${pair.number}:`);
          io.out(sanitizeForTerminal(pair.question ?? "  — abstained: no question text recognised —"));
          io.out("");
          io.out(`Antwort zu ${pair.number}:`);
          io.out(sanitizeForTerminal(pair.answer ?? "  — abstained: no answer text recognised —"));
          io.out("");
        }
        io.out("—");
        io.out(
          `tier ${record.extraction.tier} · extractor ${record.extraction.extractor_version} · ` +
            `${record.extraction.review_status}`,
        );
        if (record.extraction.abstained_fields.length > 0) {
          io.out(`abstained: ${record.extraction.abstained_fields.join(", ")}`);
        }
        for (const source of record.source_documents) {
          io.out(`${source.role}: ${source.url}${source.url_stable ? "" : " (link expires upstream)"}`);
        }
      }),
    );

  program
    .command("open")
    .description("print the path of a record's archived source document")
    .argument("<id>", "record id")
    .option("--role <role>", "which document to open when there are several", parseNonEmpty)
    .action(
      action(deps, async (ctx, positionals) => {
        const id = positionals[0] as string;
        const store = ctx.store();
        const record = store.getRecord(id);
        if (record === undefined) throw new OpenKaError(`No record ${id} in ${ctx.corpusRoot()}`);
        const role = ctx.opts["role"] as string | undefined;
        const candidates = record.source_documents.filter(
          (document) => document.sha256 !== undefined && (role === undefined || document.role === role),
        );
        const document = candidates[0];
        if (document?.sha256 === undefined) {
          throw new OpenKaError(
            `Record ${id} has no archived document${role === undefined ? "" : ` with role ${role}`}. ` +
              `It was synced with --metadata-only, or the upstream served nothing.`,
          );
        }
        if (!store.hasBlob(document.sha256)) {
          throw new OpenKaError(`The archived bytes for ${document.url} (${document.sha256}) are missing.`);
        }
        // The path is printed rather than handed to an opener: the CLI does not
        // launch other programs, and `open "$(ka open <id>)"` is one keystroke more.
        ctx.deps.io.out(store.blobPath(document.sha256));
        ctx.deps.io.err(`${document.role} · ${document.url}`);
      }),
    );
}
