// `ka sync` — the ingest command. Deterministic from end to end: discovery, fetch
// with conditional requests, the declared tier, then store and index.

import type { Command } from "commander";
import { OpenKaError, UsageError } from "@maschinenlesbar.org/openka-lib-errors";
import { SYNC_LIMIT_MIN, sync } from "@maschinenlesbar.org/openka-lib-pipeline";
import { PERIOD_RANGE } from "@maschinenlesbar.org/openka-lib-models";
import { OCR_MODES, createPerceiver, type OcrMode } from "@maschinenlesbar.org/openka-lib-perceive";
import { createSource, sourceKeyProblem, sourceKeys } from "@maschinenlesbar.org/openka-lib-registry";
import { InterruptedRunError, type CliDeps, type InterruptSignal } from "../io.js";
import { action, choiceOption, parseBoundedInt, parseIsoDate, parseNonEmpty, printJson, problemParser, toEngineOptions } from "../shared.js";
import { truncate } from "../text.js";

/** commander value-parser: a source key the registry knows — the library's `sourceKeyProblem`. */
const parseSourceKey = problemParser(sourceKeyProblem);

/**
 * The most Anfragen one `ka sync` run may take on: a cap on the command, not a
 * rule of the library, whose `sync()` only needs a limit of at least
 * `SYNC_LIMIT_MIN`.
 */
const SYNC_LIMIT_CAP = 100_000;

export function registerSync(program: Command, deps: CliDeps): void {
  program
    .command("sync")
    .description("fetch, extract and store Anfragen from a source")
    .requiredOption("--source <key>", `source to sync (${sourceKeys().join(", ")})`, parseSourceKey)
    .option("--since <date>", "only Anfragen dated on or after this date (YYYY-MM-DD)", parseIsoDate)
    .option("--until <date>", "only Anfragen dated on or before this date (YYYY-MM-DD)", parseIsoDate)
    // The window's rules are the library's (normalizeSyncWindow): these parsers
    // use the same date rule and bounds, so a typo fails before the corpus is
    // touched, and an --until before --since is refused by sync() itself.
    .option("--period <n>", "restrict to one legislative period", parseBoundedInt(...PERIOD_RANGE))
    .option("--limit <n>", "stop after this many Anfragen", parseBoundedInt(SYNC_LIMIT_MIN, SYNC_LIMIT_CAP))
    .option("--api-key <key>", "credential for sources that need one (overrides the env var)", parseNonEmpty)
    .option("--metadata-only", "do not download documents; qa is abstained")
    .option("--force", "re-extract even when inputs and extractor version are unchanged")
    .option(
      "--ignore-robots",
      "fetch documents from a server whose robots.txt disallows it — your decision, and recorded in every record's warnings",
    )
    .addOption(choiceOption("--ocr <mode>", "OCR engine for the ocr tier", OCR_MODES))
    .option("--ocr-language <lang>", "traineddata language for OCR", parseNonEmpty)
    .option("--ocr-version <version>", "require exactly this OCR engine version", parseNonEmpty)
    .option("--ocr-traineddata <path>", "traineddata file to hash into the provenance record", parseNonEmpty)
    .option("--json", "print the sync report as JSON")
    .action(
      action(deps, async (ctx) => {
        const source = createSource(ctx.opts["source"] as string);
        const store = ctx.store();
        // A source's politeness floor is applied by sync() itself, raising the
        // global --min-host-interval and never lowering it.
        const engine = ctx.deps.createEngine(toEngineOptions(ctx.global));

        const apiKey =
          (ctx.opts["apiKey"] as string | undefined) ??
          (source.apiKeyEnv === undefined ? undefined : ctx.deps.env[source.apiKeyEnv]);

        // The three OCR sub-options describe a model that only runs with --ocr.
        // Accepting them without it ran strict mode and said nothing, so a
        // corpus meant to pin tesseract 5.3.4 was built with no OCR at all.
        const ocrMode = (ctx.opts["ocr"] as OcrMode | undefined) ?? "off";
        const ocrOnly = (["ocrLanguage", "ocrVersion", "ocrTraineddata"] as const).filter(
          (key) => ctx.opts[key] !== undefined,
        );
        if (ocrMode === "off" && ocrOnly.length > 0) {
          const flags = ocrOnly.map((key) => `--${key.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`)}`);
          throw new UsageError(
            `${flags.join(", ")} only appl${flags.length === 1 ? "ies" : "y"} with --ocr tesseract or --ocr tesseract-js; ` +
              "without --ocr no model runs and the option would be ignored",
          );
        }

        // The engine and whether it can run here are the library's
        // (createPerceiver); the check above only names the flags together.
        const perceiver = await createPerceiver(ocrMode, {
          ...(ctx.opts["ocrLanguage"] === undefined ? {} : { language: ctx.opts["ocrLanguage"] as string }),
          ...(ctx.opts["ocrVersion"] === undefined ? {} : { requireVersion: ctx.opts["ocrVersion"] as string }),
          ...(ctx.opts["ocrTraineddata"] === undefined ? {} : { traineddataPath: ctx.opts["ocrTraineddata"] as string }),
        });

        // Ctrl-C finishes the Anfrage in hand and saves the catalog; a second one
        // ends the process. A kill -9 cannot be caught: the next sync over the
        // window, or `ka reindex`, catalogues what that run stored.
        const controller = new AbortController();
        let caught: InterruptSignal | undefined;
        const stopListening = ctx.deps.onInterrupt?.((signal) => {
          caught = signal;
          controller.abort();
          ctx.deps.io.err(
            `${signal === "SIGINT" ? "Interrupted" : "Terminated"} — finishing the current Anfrage and saving the ` +
              "catalog. Signal again to stop at once.",
          );
        });
        let report: Awaited<ReturnType<typeof sync>>;
        try {
          report = await sync({
            source,
            store,
            engine,
            perceiver,
            now: ctx.deps.now,
            signal: controller.signal,
            ...(ctx.opts["since"] === undefined ? {} : { since: ctx.opts["since"] as string }),
            ...(ctx.opts["until"] === undefined ? {} : { until: ctx.opts["until"] as string }),
            ...(ctx.opts["period"] === undefined ? {} : { period: ctx.opts["period"] as number }),
            ...(ctx.opts["limit"] === undefined ? {} : { limit: ctx.opts["limit"] as number }),
            ...(apiKey === undefined ? {} : { apiKey }),
            ...(ctx.opts["metadataOnly"] === true ? { metadataOnly: true } : {}),
            ...(ctx.opts["force"] === true ? { force: true } : {}),
            ...(ctx.opts["ignoreRobots"] === true ? { ignoreRobots: true } : {}),
            ...(ctx.global.quiet === true || ctx.opts["json"] === true
              ? {}
              : {
                  onProgress: (event) => {
                    if (event.action === "failed") {
                      ctx.deps.io.err(`  ! ${truncate(event.id, 40)}: ${truncate(event.detail ?? "failed", 100)}`);
                    }
                  },
                }),
          });
        } finally {
          stopListening?.();
        }

        const stopped =
          report.interrupted && caught !== undefined
            ? new InterruptedRunError(
                caught,
                `${source.key}: stopped after ${report.stored + report.unchanged + report.failed} of ` +
                  `${report.discovered} Anfragen; what was stored is catalogued. Run the same sync again to continue.`,
              )
            : undefined;

        if (ctx.opts["json"] === true) {
          printJson(ctx, report);
          if (stopped !== undefined) throw stopped;
          return;
        }

        const io = ctx.deps.io;
        if (report.upstreamUnchanged) {
          io.out(`${source.key}: upstream reports no change since the last sync — nothing to do.`);
          return;
        }
        io.out(
          `${source.key}: ${report.discovered} discovered, ${report.stored} stored, ` +
            `${report.unchanged} unchanged, ${report.failed} failed`,
        );
        if (report.needsReview > 0) {
          io.out(`${report.needsReview} of the stored records have abstained fields — see \`ka review\`.`);
        }
        if (report.recatalogued > 0) {
          io.out(
            `${report.recatalogued} unchanged record(s) were on disk but missing from the catalog ` +
              "(left by an interrupted run) and are searchable again.",
          );
        }
        for (const warning of report.warnings) io.err(`warning: ${truncate(warning, 200)}`);
        for (const error of report.errors.slice(0, 10)) io.err(`error: ${truncate(error, 200)}`);
        if (report.errors.length > 10) io.err(`… and ${report.errors.length - 10} more errors`);
        if (stopped !== undefined) throw stopped;
        if (report.errors.length > 0 && report.stored === 0) {
          throw new OpenKaError(`${source.key}: sync produced no records`);
        }
      }),
    );
}
