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
import { OpenKaError } from "@maschinenlesbar.org/openka-lib-errors";
import { PACKAGE_VERSION } from "@maschinenlesbar.org/openka-lib-repro";
import { isoInstant } from "@maschinenlesbar.org/openka-lib-pipeline";
import { defaultDeps, type CliDeps } from "@maschinenlesbar.org/openka-cli-ka";
import {
  action,
  addGlobalOptions,
  choiceOption,
  parseBoundedInt,
  parseNonEmpty,
  parseRecordId,
  printJson,
  problemParser,
  toEngineOptions,
} from "@maschinenlesbar.org/openka-cli-ka";
import { truncate } from "@maschinenlesbar.org/openka-cli-ka";
import { lintLine } from "../lib/lint.js";
import { addGolden, goldenKeyProblem, listAllGoldens, listGoldens, verifyGolden, workspaceRoot } from "../lib/goldens.js";
import {
  BASELINE_FILE,
  baselinePath,
  baselinePathProblem,
  detectDrift,
  loadBaseline,
  loadCorpusBaseline,
  measureHealth,
  saveBaseline,
} from "../lib/health.js";
import {
  buildEmbeddings,
  importEmbeddings,
  modelSha256Problem,
  DEFAULT_DIMENSIONS,
  HASHED_TFIDF,
  MAX_DIMENSIONS,
  MIN_DIMENSIONS,
} from "../lib/embed.js";
import { DRUCKSACHE_RANGE, SWEEP_PERIOD_RANGE, sweepAnswers } from "../lib/answer-index.js";
import { buildPerceiver, OCR_MODES, type OcrMode } from "@maschinenlesbar.org/openka-cli-ka";

/**
 * What `--dir` of `goldens list` and `goldens verify` defaults to, for the help
 * text. Each Land's goldens live in its own connector package, so the default is
 * not a directory at all: it is every package's `fixtures/`, found from the
 * workspace root. It is never resolved as a path — `goldens add` used to, and filed
 * goldens under a literal "every package's fixtures" directory nothing reads.
 */
export const DEFAULT_FIXTURES = "every package's fixtures/";

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
    .option("--root <dir>", "project root to scan (default: the workspace around the cwd)", parseNonEmpty)
    .option("--json", "print findings as JSON")
    .action(
      action(deps, async (ctx) => {
        // Found by walking up, like the goldens: `npm test` runs each package's
        // suite with that package as the cwd, where there is no packages/ to scan.
        const given = ctx.opts["root"] as string | undefined;
        const root = given === undefined ? workspaceRoot() : resolve(given);
        const report = lintLine(root);
        // A guardrail that scanned nothing has guarded nothing. The likely cause
        // is a wrong --root or a cwd outside the workspace, and "no violations"
        // would be the wrong answer to either.
        if (report.filesChecked === 0) {
          throw new OpenKaError(`nothing to lint: no packages/*/src under ${root} — is this the workspace root?`);
        }
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
    .argument("<id>", "record id in the corpus", parseRecordId)
    .option("--dir <dir>", "fixture directory (default: the source's connector package fixtures/)", parseNonEmpty)
    .option("--source <key>", "source folder to file it under (default: the record's parliament)", problemParser(goldenKeyProblem))
    .option("--note <text>", "what this fixture is here to pin down", parseNonEmpty)
    .action(
      action(deps, async (ctx, positionals) => {
        const id = positionals[0] as string;
        const store = ctx.existingStore();
        const record = store.getRecord(id);
        if (record === undefined) throw new OpenKaError(`No record ${id} in ${ctx.corpusRoot()}`);
        // Only what was given: where a golden belongs by default is the
        // library's call (goldenRootFor), the same layout list and verify read.
        const golden = addGolden(store, id, {
          ...(ctx.opts["dir"] === undefined ? {} : { root: resolve(ctx.opts["dir"] as string) }),
          ...(ctx.opts["source"] === undefined ? {} : { source: ctx.opts["source"] as string }),
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
        const chosen = ctx.opts["dir"] as string | undefined;
        const dir = chosen === undefined ? "every package's fixtures/" : resolve(chosen);
        const found = chosen === undefined ? listAllGoldens() : listGoldens(resolve(chosen));
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
        const chosen = ctx.opts["dir"] as string | undefined;
        const dir = chosen === undefined ? "every package's fixtures/" : resolve(chosen);
        const found = chosen === undefined ? listAllGoldens() : listGoldens(resolve(chosen));
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
    .option(
      "--save-baseline [path]",
      `write the snapshot as the drift baseline (default: ${BASELINE_FILE} in the corpus)`,
      problemParser(baselinePathProblem),
    )
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
          const path = typeof save === "string" ? resolve(save) : baselinePath(ctx.corpusRoot());
          saveBaseline(path, snapshot);
          ctx.deps.io.err(`Baseline written to ${path}.`);
        }
      }),
    );

  program
    .command("drift")
    .description("compare the corpus against the baseline and classify what changed")
    .option("--baseline <path>", `baseline snapshot (default: ${BASELINE_FILE} in the corpus)`, problemParser(baselinePathProblem))
    .option("--fail-on-drift", "exit non-zero when anything drifted, for CI")
    .option("--json", "print findings as JSON")
    .action(
      action(deps, async (ctx) => {
        const named = ctx.opts["baseline"] as string | undefined;
        const path = named === undefined ? baselinePath(ctx.corpusRoot()) : resolve(named);
        // A missing default baseline is a first run; a missing named one is an
        // error. Which is which is the library's call.
        const baseline = named === undefined ? loadCorpusBaseline(ctx.corpusRoot()) : loadBaseline(path);
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
    .requiredOption("--period <n>", "legislative period", parseBoundedInt(...SWEEP_PERIOD_RANGE))
    .requiredOption("--from <n>", "first Drucksachennummer to read", parseBoundedInt(...DRUCKSACHE_RANGE))
    .requiredOption("--to <n>", "last Drucksachennummer to read (>= --from)", parseBoundedInt(...DRUCKSACHE_RANGE))
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
        const report = await sweepAnswers({
          engine: ctx.deps.createEngine(toEngineOptions(ctx.global)),
          store: ctx.store(),
          // The range (to >= from included) is the library's to check.
          period: ctx.opts["period"] as number,
          from: ctx.opts["from"] as number,
          to: ctx.opts["to"] as number,
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
    .option("--dimensions <n>", `vector size (default: ${DEFAULT_DIMENSIONS})`, parseBoundedInt(MIN_DIMENSIONS, MAX_DIMENSIONS))
    .option("--from <file>", "import vectors from JSON Lines instead of computing them", parseNonEmpty)
    .option("--model <name>", "model name to record when importing", parseNonEmpty)
    .option("--model-sha256 <hex>", "model weights hash to record when importing", problemParser(modelSha256Problem))
    .action(
      action(deps, async (ctx) => {
        const store = ctx.store();
        const from = ctx.opts["from"] as string | undefined;
        const set =
          from === undefined
            ? buildEmbeddings(store, ctx.opts["dimensions"] as number | undefined)
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
