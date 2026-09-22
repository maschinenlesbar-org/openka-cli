// `ka sync` — the ingest command. Deterministic from end to end: discovery, fetch
// with conditional requests, the declared tier, then store and index.

import type { Command } from "commander";
import { OpenKaError } from "@maschinenlesbar.org/openka-lib-errors";
import { sync } from "@maschinenlesbar.org/openka-lib-pipeline";
import { abstainingPerceiver, type Perceiver } from "@maschinenlesbar.org/openka-lib-perceive";
import { TesseractCliPerceiver } from "@maschinenlesbar.org/openka-lib-perceive";
import { TesseractJsPerceiver } from "@maschinenlesbar.org/openka-lib-perceive";
import { createSource, sourceEntry, sourceKeys } from "@maschinenlesbar.org/openka-lib-registry";
import type { CliDeps } from "../io.js";
import { action, choiceOption, parseBoundedInt, parseIsoDate, parseNonEmpty, printJson, toEngineOptions } from "../shared.js";
import { truncate } from "../text.js";

export const OCR_MODES = ["off", "tesseract", "tesseract-js"] as const;
export type OcrMode = (typeof OCR_MODES)[number];

/**
 * Build the perceiver for an `--ocr` mode.
 *
 * `off` is the default and means strict mode: no model on the line, and scanned
 * documents abstain. The other two are the sanctioned narrow perceptual case —
 * both pin a version and hash their traineddata into the record's provenance.
 */
export async function buildPerceiver(
  mode: OcrMode,
  options: { language?: string; requireVersion?: string; traineddata?: string } = {},
): Promise<Perceiver> {
  if (mode === "off") return abstainingPerceiver;
  const shared = {
    ...(options.language === undefined ? {} : { language: options.language }),
    ...(options.requireVersion === undefined ? {} : { requireVersion: options.requireVersion }),
    ...(options.traineddata === undefined ? {} : { traineddataPath: options.traineddata }),
  };
  if (mode === "tesseract") {
    const perceiver = new TesseractCliPerceiver(shared);
    if (!perceiver.available()) {
      throw new OpenKaError(
        "--ocr tesseract needs the `tesseract` binary on PATH. Install it, pick --ocr tesseract-js " +
          "(after `npm install tesseract.js`), or leave OCR off and accept the abstentions.",
      );
    }
    return perceiver;
  }
  const perceiver = new TesseractJsPerceiver(shared);
  if (!(await perceiver.load())) {
    throw new OpenKaError(
      "--ocr tesseract-js needs the optional `tesseract.js` package. Install it with " +
        "`npm install tesseract.js`, or use --ocr tesseract with the native binary.",
    );
  }
  return perceiver;
}

export function registerSync(program: Command, deps: CliDeps): void {
  program
    .command("sync")
    .description("fetch, extract and store Anfragen from a source")
    .requiredOption("--source <key>", `source to sync (${sourceKeys().join(", ")})`, parseNonEmpty)
    .option("--since <date>", "only Anfragen dated on or after this date (YYYY-MM-DD)", parseIsoDate)
    .option("--until <date>", "only Anfragen dated on or before this date (YYYY-MM-DD)", parseIsoDate)
    .option("--period <n>", "restrict to one legislative period", parseBoundedInt(1, 99))
    .option("--limit <n>", "stop after this many Anfragen", parseBoundedInt(1, 100_000))
    .option("--api-key <key>", "credential for sources that need one (overrides the env var)", parseNonEmpty)
    .option("--metadata-only", "do not download documents; qa is abstained")
    .option("--force", "re-extract even when inputs and extractor version are unchanged")
    .addOption(choiceOption("--ocr <mode>", "OCR engine for the ocr tier", OCR_MODES))
    .option("--ocr-language <lang>", "traineddata language for OCR", parseNonEmpty)
    .option("--ocr-version <version>", "require exactly this OCR engine version", parseNonEmpty)
    .option("--ocr-traineddata <path>", "traineddata file to hash into the provenance record", parseNonEmpty)
    .option("--json", "print the sync report as JSON")
    .action(
      action(deps, async (ctx) => {
        const key = ctx.opts["source"] as string;
        const entry = sourceEntry(key);
        if (entry === undefined) {
          throw new OpenKaError(`Unknown source "${key}". Known sources: ${sourceKeys().join(", ")}.`);
        }
        const source = createSource(key);
        const store = ctx.store();
        const engine = ctx.deps.createEngine(toEngineOptions(ctx.global));

        const apiKey =
          (ctx.opts["apiKey"] as string | undefined) ??
          (source.apiKeyEnv === undefined ? undefined : ctx.deps.env[source.apiKeyEnv]);

        const perceiver = await buildPerceiver((ctx.opts["ocr"] as OcrMode | undefined) ?? "off", {
          ...(ctx.opts["ocrLanguage"] === undefined ? {} : { language: ctx.opts["ocrLanguage"] as string }),
          ...(ctx.opts["ocrVersion"] === undefined ? {} : { requireVersion: ctx.opts["ocrVersion"] as string }),
          ...(ctx.opts["ocrTraineddata"] === undefined ? {} : { traineddata: ctx.opts["ocrTraineddata"] as string }),
        });

        const report = await sync({
          source,
          store,
          engine,
          perceiver,
          now: ctx.deps.now,
          ...(ctx.opts["since"] === undefined ? {} : { since: ctx.opts["since"] as string }),
          ...(ctx.opts["until"] === undefined ? {} : { until: ctx.opts["until"] as string }),
          ...(ctx.opts["period"] === undefined ? {} : { period: ctx.opts["period"] as number }),
          ...(ctx.opts["limit"] === undefined ? {} : { limit: ctx.opts["limit"] as number }),
          ...(apiKey === undefined ? {} : { apiKey }),
          ...(ctx.opts["metadataOnly"] === true ? { metadataOnly: true } : {}),
          ...(ctx.opts["force"] === true ? { force: true } : {}),
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

        if (ctx.opts["json"] === true) {
          printJson(ctx, report);
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
        for (const warning of report.warnings) io.err(`warning: ${truncate(warning, 200)}`);
        for (const error of report.errors.slice(0, 10)) io.err(`error: ${truncate(error, 200)}`);
        if (report.errors.length > 10) io.err(`… and ${report.errors.length - 10} more errors`);
        if (report.errors.length > 0 && report.stored === 0) {
          throw new OpenKaError(`${source.key}: sync produced no records`);
        }
      }),
    );
}
