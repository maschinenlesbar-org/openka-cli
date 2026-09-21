// The factory plane: the guardrail lint, the health metrics, drift classification
// and the frozen embeddings.

import { deepStrictEqual, match, ok, strictEqual, throws } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, describe, it } from "node:test";
import { FORBIDDEN_HOSTS, FORBIDDEN_MODULES, lineFiles, lintLine, lintSource, stripComments } from "../src/factory/lib/lint.js";
import { detectDrift, measureHealth, loadBaseline, saveBaseline } from "../src/factory/lib/health.js";
import { HASHED_TFIDF, buildEmbeddings, importEmbeddings } from "../src/factory/lib/embed.js";
import { cosine } from "../src/core/search/semantic.js";
import { indexRecord } from "../src/core/store/indexer.js";
import { MemoryStore, PROJECT_ROOT, sampleRecord } from "./helpers.js";

describe("the no-LLM-on-the-line guardrail", () => {
  it("passes on this repository", () => {
    const report = lintLine(PROJECT_ROOT);
    deepStrictEqual(report.violations, []);
    ok(report.filesChecked > 30, `expected to have scanned the line, saw ${report.filesChecked} files`);
  });

  it("scans core, sources, cli and the library entry point", () => {
    const files = lineFiles(PROJECT_ROOT);
    ok(files.includes("src/index.ts"));
    ok(files.some((file) => file.startsWith("src/core/")));
    ok(files.some((file) => file.startsWith("src/sources/")));
    ok(files.some((file) => file.startsWith("src/cli/")));
    ok(!files.some((file) => file.startsWith("src/factory/")));
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
