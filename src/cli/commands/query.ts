// The read side: `search`, `get`, `show` and `open`.

import type { Command } from "commander";
import { OpenKaError, UsageError } from "../../core/errors.js";
import { parliamentByKey } from "../../core/models/parliaments.js";
import { ReviewStatuses, type KaRecord } from "../../core/models/schema.js";
import { search } from "../../core/search/search.js";
import { searchLike } from "../../core/search/semantic.js";
import { RENDER_FORMATS, renderRecord, type RenderFormat } from "../../core/render/render.js";
import type { CatalogEntry } from "../../core/store/store.js";
import type { CliDeps } from "../io.js";
import {
  action,
  addCorpusFilters,
  choiceOption,
  corpusFiltersFrom,
  parseBoundedInt,
  parseNonEmpty,
  printJson,
} from "../shared.js";
import { pad, sanitizeForTerminal, truncate } from "../text.js";

/** The shared filters plus the two only the read commands offer. */
function addFilterOptions(command: Command): Command {
  return addCorpusFilters(command)
    .addOption(choiceOption("--review-status <status>", "restrict by review status", ReviewStatuses))
    .option("--needs-review", "only records with at least one abstained field");
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

/**
 * `ka show`, as lines.
 *
 * A pure function of the record rather than a sequence of `io.out` calls inside
 * the registration closure, so the formatting can be asserted directly instead of
 * only through the whole CLI. Every field goes through `sanitizeForTerminal`: a
 * title, a URL and an attachment label are all upstream data.
 */
export function renderShowLines(record: KaRecord): string[] {
  const parliament = parliamentByKey(record.parliament);
  const lines: string[] = [];
  lines.push(sanitizeForTerminal(record.title || "(no title)"));
  lines.push(
    `${parliament?.label ?? record.parliament} · Drucksache ${sanitizeForTerminal(record.reference)} · ` +
      `WP ${record.legislative_period}`,
  );
  const askers = record.askers
    .map((asker) => (asker.party === undefined ? asker.name : `${asker.name} (${asker.party})`))
    .join(", ");
  if (askers !== "") lines.push(`Gefragt von: ${sanitizeForTerminal(askers)}`);
  if (record.answered_by.ministry !== undefined) {
    lines.push(`Beantwortet von: ${sanitizeForTerminal(record.answered_by.ministry)}`);
  }
  lines.push(
    [
      record.dates.submitted === undefined ? undefined : `eingereicht ${record.dates.submitted}`,
      record.dates.answered === undefined ? undefined : `beantwortet ${record.dates.answered}`,
    ]
      .filter(Boolean)
      .join(" · "),
  );
  lines.push("");
  if (record.markers.classified) lines.push("[ als Verschlusssache gekennzeichnet ]");
  if (record.markers.attachments_referenced.length > 0) {
    lines.push(`[ Anlagen: ${sanitizeForTerminal(record.markers.attachments_referenced.join(", "))} ]`);
  }
  if (record.qa.length === 0) lines.push("(no question/answer pairs were extracted)");
  for (const pair of record.qa) {
    lines.push(`Frage ${sanitizeForTerminal(pair.number)}:`);
    lines.push(sanitizeForTerminal(pair.question ?? "  — abstained: no question text recognised —"));
    lines.push("");
    lines.push(`Antwort zu ${sanitizeForTerminal(pair.number)}:`);
    lines.push(sanitizeForTerminal(pair.answer ?? "  — abstained: no answer text recognised —"));
    lines.push("");
  }
  lines.push("—");
  lines.push(
    `tier ${record.extraction.tier} · extractor ${sanitizeForTerminal(record.extraction.extractor_version)} · ` +
      `${record.extraction.review_status}`,
  );
  if (record.extraction.abstained_fields.length > 0) {
    lines.push(`abstained: ${sanitizeForTerminal(record.extraction.abstained_fields.join(", "))}`);
  }
  for (const source of record.source_documents) {
    // A URL is scraped out of upstream HTML, which makes it among the most
    // attacker-influenced strings in the record.
    lines.push(`${source.role}: ${sanitizeForTerminal(source.url)}${source.url_stable ? "" : " (link expires upstream)"}`);
  }
  return lines;
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
      const filters = corpusFiltersFrom(ctx.opts);
      const limit = (ctx.opts["limit"] as number | undefined) ?? 20;

      if (ctx.opts["like"] !== undefined) {
        // The semantic path honours the filters and --limit, and nothing else.
        // Accepting the rest and quietly dropping them is the failure this CLI
        // refuses elsewhere: a search that ignores what it was asked for and
        // answers something different.
        const ignored = [
          positionals[0] !== undefined && positionals[0] !== "" ? "a query argument" : undefined,
          ctx.opts["offset"] !== undefined ? "--offset" : undefined,
          ctx.opts["snippet"] === true ? "--snippet" : undefined,
        ].filter((name): name is string => name !== undefined);
        if (ignored.length > 0) {
          throw new UsageError(
            `--like cannot be combined with ${ignored.join(", ")}. Semantic search ranks by ` +
              "similarity to one record; it has no query terms to offset or to highlight.",
          );
        }
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
        for (const line of renderShowLines(record)) ctx.deps.io.out(line);
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
        ctx.deps.io.err(`${document.role} · ${sanitizeForTerminal(document.url)}`);
      }),
    );
}
