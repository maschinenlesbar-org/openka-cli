// `ka-factory` — the build-time tooling. Separate binary, separate command tree,
// and deliberately not reachable from the line (`ka-factory lint` enforces that).
//
// What lives here is everything the concept puts on the factory plane: the
// guardrail check, the golden fixtures, the health metrics and the drift
// classification that decides when an extractor needs regenerating. What does *not*
// live here is an LLM client. Claude Code is the agent that runs these commands and
// writes the extractor code; the factory tooling itself stays deterministic so its
// output can be trusted as evidence.

import { Command } from "commander";
import { resolve } from "node:path";
import { OpenKaError } from "../../core/errors.js";
import { PACKAGE_VERSION } from "../../core/repro/version.js";
import { isoInstant } from "../../core/pipeline/pipeline.js";
import { defaultDeps, type CliDeps } from "../../cli/io.js";
import {
  action,
  addGlobalOptions,
  choiceOption,
  parseBoundedInt,
  parseNonEmpty,
  printJson,
  toEngineOptions,
} from "../../cli/shared.js";
import { truncate } from "../../cli/text.js";
import { lintLine } from "../lib/lint.js";
import { addGolden, listGoldens, verifyGolden } from "../lib/goldens.js";
import { detectDrift, loadBaseline, measureHealth, saveBaseline } from "../lib/health.js";
import { buildEmbeddings, importEmbeddings, DEFAULT_DIMENSIONS, HASHED_TFIDF } from "../lib/embed.js";
import { sweepAnswers } from "../lib/answer-index.js";
import { buildPerceiver, OCR_MODES, type OcrMode } from "../../cli/commands/sync.js";

export const DEFAULT_FIXTURES = "fixtures";
/**
 * Where `health --save-baseline` writes and `drift` reads by default.
 *
 * Generated, not shipped — it measures one machine's corpus, so the repository
 * gitignores it rather than committing someone else's numbers. Its absence is the
 * "first run" case `drift` reports and does not treat as an error.
 */
export const DEFAULT_BASELINE = "fixtures/health-baseline.json";

export function buildFactoryProgram(deps: CliDeps = defaultDeps): Command {
  const program = new Command();
  program
    .name("ka-factory")
    .description(
      "OpenKA factory — build-time tooling for the deterministic line.\n" +
        "Guardrail lint, golden fixtures, coverage metrics and drift classification.\n" +
        "Nothing here runs at execution time, and nothing here calls a model.",
    )
    .version(PACKAGE_VERSION, "-v, --version")
    .showHelpAfterError();

  addGlobalOptions(program);

  program
    .command("lint")
    .description("check that no code on the line can reach a generative model")
    .option("--root <dir>", "project root to scan", parseNonEmpty)
    .option("--json", "print findings as JSON")
    .action(
      action(deps, async (ctx) => {
        const root = resolve((ctx.opts["root"] as string | undefined) ?? process.cwd());
        const report = lintLine(root);
        if (ctx.opts["json"] === true) {
          printJson(ctx, report);
        } else {
          for (const violation of report.violations) {
            ctx.deps.io.out(`${violation.file}:${violation.line}: [${violation.rule}] ${violation.detail}`);
          }
          ctx.deps.io.out(
            report.violations.length === 0
              ? `No generative-model dependency on the line (${report.filesChecked} file(s) checked).`
              : `${report.violations.length} violation(s) in ${report.filesChecked} file(s) checked.`,
          );
        }
        if (report.violations.length > 0) {
          throw new OpenKaError("the line must not be able to reach a generative model");
        }
      }),
    );

  const goldens = program.command("goldens").description("golden fixtures: frozen input→record pairs");

  goldens
    .command("add")
    .description("freeze a record and its input bytes as a golden fixture")
    .argument("<id>", "record id in the corpus")
    .option("--dir <dir>", `fixture directory (default: ${DEFAULT_FIXTURES})`, parseNonEmpty)
    .option("--source <key>", "source folder to file it under (default: the record's parliament)", parseNonEmpty)
    .option("--note <text>", "what this fixture is here to pin down", parseNonEmpty)
    .action(
      action(deps, async (ctx, positionals) => {
        const id = positionals[0] as string;
        const store = ctx.store();
        const record = store.getRecord(id);
        if (record === undefined) throw new OpenKaError(`No record ${id} in ${ctx.corpusRoot()}`);
        const dir = resolve((ctx.opts["dir"] as string | undefined) ?? DEFAULT_FIXTURES);
        const source = (ctx.opts["source"] as string | undefined) ?? record.parliament;
        const golden = addGolden(store, dir, id, source, {
          ...(ctx.opts["note"] === undefined ? {} : { note: ctx.opts["note"] as string }),
        });
        ctx.deps.io.out(`Froze ${id} as a golden in ${golden.dir}`);
        if (record.extraction.abstained_fields.length > 0) {
          ctx.deps.io.err(
            `Note: this record has ${record.extraction.abstained_fields.length} abstained field(s). ` +
              "Freezing it pins the abstentions too, which is useful as a regression guard — but check " +
              "against the PDF before treating it as ground truth.",
          );
        }
      }),
    );

  goldens
    .command("list")
    .description("the goldens on disk")
    .option("--dir <dir>", `fixture directory (default: ${DEFAULT_FIXTURES})`, parseNonEmpty)
    .option("--json", "print as JSON")
    .action(
      action(deps, async (ctx) => {
        const dir = resolve((ctx.opts["dir"] as string | undefined) ?? DEFAULT_FIXTURES);
        const found = listGoldens(dir);
        if (ctx.opts["json"] === true) {
          printJson(ctx, found.map((golden) => golden.meta));
          return;
        }
        if (found.length === 0) {
          ctx.deps.io.out(`No goldens in ${dir}.`);
          return;
        }
        for (const golden of found) {
          ctx.deps.io.out(
            `${golden.meta.id}  ${golden.meta.tier}  ${golden.meta.human_verified ? "verified" : "unverified"}  ` +
              `${golden.record.qa.length} pair(s)  ${truncate(golden.meta.note ?? golden.record.title, 60)}`,
          );
        }
        ctx.deps.io.err(`${found.length} golden(s) in ${dir}.`);
      }),
    );

  goldens
    .command("verify", { isDefault: true })
    .description("re-extract every golden from its frozen bytes and compare")
    .option("--dir <dir>", `fixture directory (default: ${DEFAULT_FIXTURES})`, parseNonEmpty)
    .addOption(choiceOption("--ocr <mode>", "OCR engine for goldens produced with one", OCR_MODES))
    .option("--json", "print results as JSON")
    .action(
      action(deps, async (ctx) => {
        const dir = resolve((ctx.opts["dir"] as string | undefined) ?? DEFAULT_FIXTURES);
        const found = listGoldens(dir);
        if (found.length === 0) throw new OpenKaError(`No goldens in ${dir} — nothing to verify.`);
        const mode = (ctx.opts["ocr"] as OcrMode | undefined) ?? "off";
        const perceiver = mode === "off" ? undefined : await buildPerceiver(mode);

        const results = [];
        for (const golden of found) results.push(await verifyGolden(golden, perceiver));
        const failed = results.filter((result) => !result.ok);

        if (ctx.opts["json"] === true) {
          printJson(ctx, { checked: results.length, passed: results.length - failed.length, results });
        } else {
          for (const result of failed) {
            ctx.deps.io.out(`FAIL ${result.id}: ${result.reason ?? "mismatch"}`);
            for (const path of result.differences.slice(0, 10)) ctx.deps.io.out(`       differs at ${path}`);
          }
          ctx.deps.io.out(`${results.length - failed.length}/${results.length} golden(s) reproduced.`);
        }
        if (failed.length > 0) {
          throw new OpenKaError(
            `${failed.length} golden(s) regressed — an extractor may not be promoted while a golden is red`,
          );
        }
      }),
    );

  program
    .command("health")
    .description("coverage and abstention metrics per source")
    .option("--json", "print as JSON")
    .option("--save-baseline [path]", `write the snapshot as the drift baseline (default: ${DEFAULT_BASELINE})`)
    .action(
      action(deps, async (ctx) => {
        const snapshot = measureHealth(ctx.store(), isoInstant(ctx.deps.now()));
        if (ctx.opts["json"] === true) printJson(ctx, snapshot);
        else {
          ctx.deps.io.out(`${snapshot.records} record(s) in ${ctx.corpusRoot()}`);
          for (const source of snapshot.sources) {
            ctx.deps.io.out(
              `  ${source.source}: ${source.records} record(s), ` +
                `${(source.qa_rate * 100).toFixed(0)}% with Q/A, ` +
                `${(source.abstention_rate * 100).toFixed(0)}% abstaining somewhere`,
            );
            if (source.last_error !== undefined) ctx.deps.io.out(`    last error: ${truncate(source.last_error, 110)}`);
          }
        }
        const save = ctx.opts["saveBaseline"];
        if (save !== undefined && save !== false) {
          const path = resolve(typeof save === "string" ? save : DEFAULT_BASELINE);
          saveBaseline(path, snapshot);
          ctx.deps.io.err(`Baseline written to ${path}.`);
        }
      }),
    );

  program
    .command("drift")
    .description("compare the corpus against the baseline and classify what changed")
    .option("--baseline <path>", `baseline snapshot (default: ${DEFAULT_BASELINE})`, parseNonEmpty)
    .option("--fail-on-drift", "exit non-zero when anything drifted, for CI")
    .option("--json", "print findings as JSON")
    .action(
      action(deps, async (ctx) => {
        const named = ctx.opts["baseline"] as string | undefined;
        const path = resolve(named ?? DEFAULT_BASELINE);
        const baseline = loadBaseline(path);
        // A missing *default* baseline means "first run". A missing path the caller
        // named is a typo, and answering a typo with "every source is new, nothing
        // is wrong" is the worst reading available.
        if (baseline === undefined && named !== undefined) {
          throw new OpenKaError(`No baseline at ${path}. Write one with \`ka-factory health --save-baseline\`.`);
        }
        const snapshot = measureHealth(ctx.store(), isoInstant(ctx.deps.now()));
        const findings = detectDrift(snapshot, baseline);
        if (ctx.opts["json"] === true) {
          printJson(ctx, { baseline: baseline?.taken_at ?? null, findings });
        } else {
          if (baseline === undefined) {
            ctx.deps.io.err(`No baseline at ${path}; run \`ka-factory health --save-baseline\` first.`);
          }
          if (findings.length === 0) {
            ctx.deps.io.out("No drift against the baseline.");
          } else {
            for (const finding of findings) {
              ctx.deps.io.out(`${finding.source} [${finding.kind}] ${finding.detail}`);
              ctx.deps.io.out(`    → ${finding.suggestion}`);
            }
          }
        }
        // Drift findings are signals rather than pass/fail, which is why this is
        // opt-in — but without it there was no exit code at all, so the one signal
        // the heal loop exists to act on could not fail a build, while `lint` and
        // `goldens verify` both can.
        if (ctx.opts["failOnDrift"] === true && findings.length > 0) {
          throw new OpenKaError(`${findings.length} drift finding(s) against ${path}`);
        }
      }),
    );

  program
    .command("answers")
    .description("sweep a Drucksachen range and freeze the question→answer map a source needs")
    .argument("<source>", "source key; only `niedersachsen` needs this today")
    .requiredOption("--period <n>", "legislative period", parseBoundedInt(1, 99))
    .requiredOption("--from <n>", "first Drucksachennummer to read", parseBoundedInt(1, 999_999))
    .requiredOption("--to <n>", "last Drucksachennummer to read", parseBoundedInt(1, 999_999))
    .option("--merge", "keep entries from a previous sweep instead of replacing the map")
    .option("--json", "print the report as JSON")
    .action(
      action(deps, async (ctx, positionals) => {
        const source = positionals[0] as string;
        if (source !== "niedersachsen") {
          throw new OpenKaError(
            `No answer sweep is defined for "${source}". Only niedersachsen needs one: every other ` +
              "source reaches its answers through discovery.",
          );
        }
        const from = ctx.opts["from"] as number;
        const to = ctx.opts["to"] as number;
        if (to < from) throw new OpenKaError(`--to (${to}) is before --from (${from}).`);

        const report = await sweepAnswers({
          engine: ctx.deps.createEngine(toEngineOptions(ctx.global)),
          store: ctx.store(),
          period: ctx.opts["period"] as number,
          from,
          to,
          now: isoInstant(ctx.deps.now()),
          ...(ctx.opts["merge"] === true ? { merge: true } : {}),
          ...(ctx.global.quiet === true || ctx.opts["json"] === true
            ? {}
            : {
                onProgress: (event) => {
                  if (event.outcome === "answer") ctx.deps.io.err(`  + ${event.number}`);
                },
              }),
        });

        if (ctx.opts["json"] === true) {
          printJson(ctx, report);
          return;
        }
        ctx.deps.io.out(
          `Read ${report.scanned} Drucksache(n): ${report.answers} answer(s), ${report.questions} question(s), ` +
            `${report.missing} not published, ${report.unreadable} unreadable.`,
        );
        ctx.deps.io.out(`The map now links ${report.total} question(s) to an answer.`);
      }),
    );

  program
    .command("embed")
    .description("build the frozen embeddings the line uses for `ka search --like`")
    .option("--dimensions <n>", `vector size (default: ${DEFAULT_DIMENSIONS})`, parseBoundedInt(16, 4096))
    .option("--from <file>", "import vectors from JSON Lines instead of computing them", parseNonEmpty)
    .option("--model <name>", "model name to record when importing", parseNonEmpty)
    .option("--model-sha256 <hex>", "model weights hash to record when importing", parseNonEmpty)
    .action(
      action(deps, async (ctx) => {
        const store = ctx.store();
        const from = ctx.opts["from"] as string | undefined;
        const set =
          from === undefined
            ? buildEmbeddings(store, (ctx.opts["dimensions"] as number | undefined) ?? DEFAULT_DIMENSIONS)
            : importEmbeddings(from, {
                model: (ctx.opts["model"] as string | undefined) ?? "imported",
                ...(ctx.opts["modelSha256"] === undefined ? {} : { modelSha256: ctx.opts["modelSha256"] as string }),
              });
        store.saveEmbeddings(set);
        ctx.deps.io.out(
          `Wrote ${Object.keys(set.vectors).length} vector(s) of ${set.dimensions} dimensions (${set.model}).`,
        );
        if (set.model === HASHED_TFIDF) {
          ctx.deps.io.err(
            "These are hashed TF-IDF projections, not language-model embeddings: they find shared " +
              "distinctive vocabulary, not shared meaning. Import real vectors with --from when you need more.",
          );
        }
      }),
    );

  return program;
}
