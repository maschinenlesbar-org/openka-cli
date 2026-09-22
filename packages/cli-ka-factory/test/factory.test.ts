// The factory plane: the guardrail lint, the health metrics, drift classification
// and the frozen embeddings.

import { deepStrictEqual, match, ok, strictEqual, throws } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, describe, it } from "node:test";
import { FORBIDDEN_HOSTS, FORBIDDEN_MODULES, lineFiles, lineRoots, lintLine, lintSource, stripComments } from "../src/lib/lint.js";
import { detectDrift, measureHealth, loadBaseline, saveBaseline } from "../src/lib/health.js";
import { HASHED_TFIDF, buildEmbeddings, importEmbeddings } from "../src/lib/embed.js";
import { cosine } from "@maschinenlesbar.org/openka-lib-search";
import { indexRecord } from "@maschinenlesbar.org/openka-lib-store";
import { MemoryStore, sampleRecord , PROJECT_ROOT } from "@maschinenlesbar.org/openka-lib-testing";

describe("the no-LLM-on-the-line guardrail", () => {
  it("passes on this repository", () => {
    const report = lintLine(PROJECT_ROOT);
    deepStrictEqual(report.violations, []);
    ok(report.filesChecked > 30, `expected to have scanned the line, saw ${report.filesChecked} files`);
  });

  it("catches a forbidden import however it is written", () => {
    // A line-by-line scan missed the multi-line form, which is the prevailing
    // style in this codebase — so the guardrail enforced nothing against the
    // ordinary way of writing an import.
    const forms = [
      'import OpenAI from "openai";',
      'import {\n  OpenAI,\n  type Client,\n} from "openai";',
      'import "openai";',
      'const m = await import("openai");',
      'const m = require("openai");',
      'import type { X } from "openai";',
      'export { x } from "openai";',
    ];
    for (const source of forms) {
      const rules = lintSource("x.ts", source).map((violation) => violation.rule);
      deepStrictEqual(rules, ["forbidden-module"], `not caught: ${JSON.stringify(source)}`);
    }
  });

  it("catches a multi-line factory import", () => {
    const rules = lintSource("x.ts", 'import {\n  buildEmbeddings,\n} from "../factory/lib/embed.js";').map(
      (violation) => violation.rule,
    );
    deepStrictEqual(rules, ["factory-import"]);
  });

  it("does not trip on an ordinary import that merely mentions the word", () => {
    deepStrictEqual(lintSource("x.ts", 'import { sha256 } from "../repro/hash.js";\nconst s = "not from openai";'), []);
  });

  it("scans every package on the line", () => {
    const files = lineFiles(PROJECT_ROOT);
    // The published entry point is a package now, so there is nothing outside
    // `packages/` for this to special-case.
    ok(files.some((file) => file.startsWith("packages/openka-cli/src/")));
    ok(!files.some((file) => /^src\//.test(file)));
    for (const pkg of ["lib-pdf", "lib-extract", "lib-source", "cli-ka", "connector-bund"]) {
      ok(files.some((file) => file.startsWith(`packages/${pkg}/src/`)), `${pkg} is not being scanned`);
    }
    // The factory is the one package that is not on the line.
    ok(!files.some((file) => file.startsWith("packages/cli-ka-factory/")));
  });

  it("finds a connector added later without being told about it", () => {
    // The roots are discovered, not listed, so a new Land is covered the moment its
    // package exists rather than when someone remembers to add it to the lint.
    const roots = lineRoots(PROJECT_ROOT);
    ok(roots.includes("packages/connector-schleswig-holstein/src"));
    ok(!roots.includes("packages/cli-ka-factory/src"));
  });

  it("catches an import of a model client", () => {
    for (const module of ["openai", "@anthropic-ai/sdk", "langchain"]) {
      const violations = lintSource("x.ts", `import x from "${module}";`);
      strictEqual(violations[0]?.rule, "forbidden-module");
    }
  });

  it("catches a dynamic import and a require of one too", () => {
    ok(lintSource("x.ts", 'const m = await import("openai");').length > 0);
    ok(lintSource("x.ts", 'const m = require("cohere-ai");').length > 0);
  });

  it("catches a model provider's host in a string", () => {
    const violations = lintSource("x.ts", 'const url = "https://api.openai.com/v1/chat";');
    strictEqual(violations[0]?.rule, "forbidden-host");
  });

  it("catches the line importing factory tooling", () => {
    const violations = lintSource("src/core/x.ts", 'import { heal } from "../factory/lib/heal.js";');
    strictEqual(violations[0]?.rule, "factory-import");
  });

  it("does not fire on a module whose name merely starts the same way", () => {
    deepStrictEqual(lintSource("x.ts", 'import x from "openai-ish-name-that-is-not-it";'), []);
  });

  it("lets a module write about the rule in a comment", () => {
    deepStrictEqual(lintSource("x.ts", '// we never import "openai" here\n// not even api.openai.com\n'), []);
    deepStrictEqual(lintSource("x.ts", '/* openai, api.anthropic.com */\n'), []);
  });

  it("keeps line numbers correct after stripping a block comment", () => {
    const stripped = stripComments("/* one\ntwo */\nimport x from \"openai\";");
    strictEqual(stripped.split("\n").length, 3);
    strictEqual(lintSource("x.ts", "/* one\ntwo */\nimport x from \"openai\";")[0]?.line, 3);
  });

  it("does not mistake a string containing a slash-star for a comment", () => {
    deepStrictEqual(lintSource("x.ts", 'const s = "/* not a comment */";'), []);
  });

  it("lists the modules and hosts it knows about", () => {
    ok(FORBIDDEN_MODULES.length > 5);
    ok(FORBIDDEN_HOSTS.includes("api.anthropic.com"));
    // OCR is the one sanctioned model on the line and must not be blocked.
    ok(!(FORBIDDEN_MODULES as readonly string[]).includes("tesseract.js"));
  });
});

function corpus(): MemoryStore {
  const store = new MemoryStore();
  const records = [
    sampleRecord(),
    sampleRecord({
      id: "berlin-19-22222",
      reference: "19/22222",
      title: "Sanierung der Radwege",
      qa: [],
      full_text: "Radwege überall",
      extraction: {
        ...sampleRecord().extraction,
        parse_complete: false,
        abstained_fields: ["qa"],
        review_status: "needs_review",
      },
    }),
  ];
  for (const record of records) {
    store.putRecord(record);
    indexRecord(store, record);
  }
  return store;
}

describe("health metrics", () => {
  it("shows a source that synced and stored nothing", () => {
    // Previously the report was built only from catalog rows, so a source whose
    // discovery returned nothing left no row — and `no_results`, one of the six
    // documented drift signals, could never fire from the real pipeline.
    const store = new MemoryStore();
    store.putSourceState({ source: "hamburg", http_cache: {}, last_sync: "2026-01-02T03:04:05Z" });
    const snapshot = measureHealth(store, "2026-01-02T03:04:05Z");
    deepStrictEqual(snapshot.sources.map((source) => source.source), ["hamburg"]);
    strictEqual(snapshot.sources[0]?.records, 0);
    deepStrictEqual(detectDrift(snapshot, undefined).map((finding) => finding.kind), ["no_results"]);
  });

  it("surfaces the error of a source that stored nothing", () => {
    const store = new MemoryStore();
    store.putSourceState({ source: "hamburg", http_cache: {}, last_error: "the endpoint moved" });
    const findings = detectDrift(measureHealth(store, "t1"), undefined);
    deepStrictEqual(findings.map((finding) => finding.kind), ["no_results", "source_error"]);
  });

  it("does not report the all-Länder aggregator as empty", () => {
    // Its records are filed under sixteen other parliaments, so a zero of its own
    // would be a permanent false finding.
    const store = new MemoryStore();
    store.putSourceState({ source: "parlamentsspiegel", http_cache: {}, last_sync: "t1" });
    deepStrictEqual(measureHealth(store, "t1").sources, []);
  });

  it("measures coverage per source", () => {
    const snapshot = measureHealth(corpus(), "2026-01-02T03:04:05Z");
    strictEqual(snapshot.records, 2);
    const berlin = snapshot.sources[0];
    strictEqual(berlin?.source, "berlin");
    strictEqual(berlin?.parse_complete, 1);
    strictEqual(berlin?.abstention_rate, 0.5);
    strictEqual(berlin?.qa_rate, 0.5);
  });

  it("round-trips a baseline through a file", () => {
    const dir = mkdtempSync(join(tmpdir(), "openka-health-"));
    const path = join(dir, "baseline.json");
    const snapshot = measureHealth(corpus(), "2026-01-02T03:04:05Z");
    saveBaseline(path, snapshot);
    deepStrictEqual(loadBaseline(path), snapshot);
    strictEqual(loadBaseline(join(dir, "missing.json")), undefined);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("drift classification", () => {
  const baseline = measureHealth(corpus(), "2026-01-01T00:00:00Z");

  it("reports a source that is new against the baseline", () => {
    const findings = detectDrift(measureHealth(corpus(), "2026-01-02T00:00:00Z"), undefined);
    strictEqual(findings[0]?.kind, "new_source");
  });

  it("finds nothing when nothing changed", () => {
    deepStrictEqual(detectDrift(measureHealth(corpus(), "2026-01-02T00:00:00Z"), baseline), []);
  });

  it("distinguishes an abstention spike from a discovery failure", () => {
    const worse = {
      ...baseline,
      sources: [{ ...baseline.sources[0]!, abstention_rate: 0.95, qa_rate: 0.05 }],
    };
    const findings = detectDrift(worse, baseline);
    ok(findings.some((finding) => finding.kind === "abstention_spike"));
    ok(findings.some((finding) => finding.kind === "qa_collapse"));
    match(findings.find((finding) => finding.kind === "abstention_spike")?.suggestion ?? "", /documents changed shape/);
  });

  it("reports a failing source with a repair suggestion aimed at discovery", () => {
    const failing = {
      ...baseline,
      sources: [{ ...baseline.sources[0]!, last_error: "HTTP 404 for GET https://…" }],
    };
    const findings = detectDrift(failing, baseline);
    strictEqual(findings[0]?.kind, "source_error");
    match(findings[0]?.suggestion ?? "", /endpoint moved/);
  });

  it("reports a source that disappeared from the corpus", () => {
    const findings = detectDrift({ taken_at: "2026-01-02T00:00:00Z", records: 0, sources: [] }, baseline);
    strictEqual(findings[0]?.kind, "coverage_drop");
  });
});

describe("frozen embeddings", () => {
  it("builds unit vectors and names what produced them", () => {
    const set = buildEmbeddings(corpus(), 64);
    strictEqual(set.model, HASHED_TFIDF);
    strictEqual(set.dimensions, 64);
    strictEqual(Object.keys(set.vectors).length, 2);
    const vector = set.vectors["berlin-19-12345"] as number[];
    ok(Math.abs(Math.hypot(...vector) - 1) < 1e-4);
  });

  it("is deterministic", () => {
    deepStrictEqual(buildEmbeddings(corpus(), 64), buildEmbeddings(corpus(), 64));
  });

  it("places a record nearer to itself than to an unrelated one", () => {
    const set = buildEmbeddings(corpus(), 256);
    const a = set.vectors["berlin-19-12345"] as number[];
    const b = set.vectors["berlin-19-22222"] as number[];
    ok(cosine(a, a) > cosine(a, b));
  });

  it("imports vectors from JSON Lines, recording their provenance", () => {
    const dir = mkdtempSync(join(tmpdir(), "openka-embed-"));
    const path = join(dir, "vectors.jsonl");
    writeFileSync(path, '{"id":"a","vector":[1,0]}\n{"id":"b","vector":[0,1]}\n');
    const set = importEmbeddings(path, { model: "some-encoder", modelSha256: "a".repeat(64) });
    strictEqual(set.dimensions, 2);
    strictEqual(set.model_sha256, "a".repeat(64));
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses an empty vector and a duplicate id", () => {
    // An empty first vector left `dimensions` at 0, so the next line defined the
    // set's dimensionality and the empty one stayed — a set that imports cleanly
    // and then throws "vector length mismatch" during a search.
    const dir = mkdtempSync(join(tmpdir(), "openka-embed-"));
    const empty = join(dir, "empty.jsonl");
    writeFileSync(empty, '{"id":"a","vector":[]}\n{"id":"b","vector":[1,2,3]}\n');
    throws(() => importEmbeddings(empty, { model: "x" }), /vector is empty/);
    const duplicate = join(dir, "duplicate.jsonl");
    writeFileSync(duplicate, '{"id":"b","vector":[1,2]}\n{"id":"b","vector":[9,9]}\n');
    throws(() => importEmbeddings(duplicate, { model: "x" }), /duplicate id "b"/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a ragged or non-numeric import instead of storing nonsense", () => {
    const dir = mkdtempSync(join(tmpdir(), "openka-embed-"));
    const ragged = join(dir, "ragged.jsonl");
    writeFileSync(ragged, '{"id":"a","vector":[1,0]}\n{"id":"b","vector":[1]}\n');
    throws(() => importEmbeddings(ragged, { model: "x" }), /dimensions/);
    const bad = join(dir, "bad.jsonl");
    writeFileSync(bad, '{"id":"a","vector":["x"]}\n');
    throws(() => importEmbeddings(bad, { model: "x" }), /non-finite/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("temporary directories", () => {
  const dir = mkdtempSync(join(tmpdir(), "openka-noop-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  it("exists", () => ok(dir.length > 0));
});
