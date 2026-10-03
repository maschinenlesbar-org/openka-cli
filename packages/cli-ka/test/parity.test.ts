// CLI <-> library parity: the same input through `run()` and through the library
// function the CLI wraps must give the same outcome. Each `describe` below pins one
// rule that used to live only in a commander parser or a command action.

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FileStore, indexRecord } from "@maschinenlesbar.org/openka-lib-store";
import { sampleRecord } from "@maschinenlesbar.org/openka-lib-testing";
import { addGolden, importEmbeddings, loadBaseline, saveBaseline } from "@maschinenlesbar.org/openka-cli-ka-factory";
import { OpenKaValidationError, UsageError } from "@maschinenlesbar.org/openka-lib-errors";
import { runFactory } from "@maschinenlesbar.org/openka-cli-ka-factory";
import { EXIT_USAGE, run } from "../src/run.js";
import { TesseractCliPerceiver, TesseractJsPerceiver } from "@maschinenlesbar.org/openka-lib-perceive";
import { cliHarness } from "./harness.js";
import { parity } from "./helpers.js";

describe("a validation error raised inside an action", () => {
  const refusing = (): never => {
    throw new OpenKaValidationError("Invalid corpus: Expected a non-empty value.", { reason: "Expected a non-empty value." });
  };

  it("exits 2 from ka, printed as Error: <message>", async () => {
    const harness = cliHarness();
    harness.deps.createStore = refusing;
    strictEqual(await run(["--corpus", harness.corpus, "stats"], harness.deps), EXIT_USAGE);
    strictEqual(harness.stderr(), "Error: Invalid corpus: Expected a non-empty value.");
    harness.cleanup();
  });

  it("exits 2 from ka-factory, printed the same way", async () => {
    const harness = cliHarness();
    harness.deps.createStore = refusing;
    strictEqual(await runFactory(["--corpus", harness.corpus, "health"], harness.deps), EXIT_USAGE);
    strictEqual(harness.stderr(), "Error: Invalid corpus: Expected a non-empty value.");
    harness.cleanup();
  });
});

describe("the parity helper", () => {
  it("reports both outcomes, and the requests each side made", async () => {
    const result = await parity({
      argv: ["--help"],
      lib: () => {
        throw new UsageError("refused");
      },
    });
    strictEqual(result.cli.code, 0);
    ok(result.cli.out.includes("Usage: ka"));
    deepStrictEqual(result.cli.requests, []);
    deepStrictEqual(result.lib, { ok: false, error: { name: "UsageError", message: "refused" }, requests: [] });
  });
});

describe("blank OCR options (finding 11)", () => {
  const cases = [
    { flag: "--ocr-language", option: "language" },
    { flag: "--ocr-version", option: "requireVersion" },
    { flag: "--ocr-traineddata", option: "traineddataPath" },
  ] as const;

  for (const { flag, option } of cases) {
    for (const blank of ["", "  "]) {
      it(`refuses ${flag} ${JSON.stringify(blank)} on both sides, before any request`, async () => {
        for (const [mode, Perceiver] of [
          ["tesseract", TesseractCliPerceiver],
          ["tesseract-js", TesseractJsPerceiver],
        ] as const) {
          const result = await parity({
            argv: (corpus) => ["--corpus", corpus, "sync", "--source", "berlin", "--ocr", mode, flag, blank],
            lib: () => new Perceiver({ [option]: blank }),
          });
          strictEqual(result.cli.code, EXIT_USAGE);
          ok(result.cli.err.includes("Expected a non-empty value."), result.cli.err);
          deepStrictEqual(result.cli.requests, []);
          deepStrictEqual(result.lib, {
            ok: false,
            error: { name: "OpenKaValidationError", message: `Invalid ${option}: Expected a non-empty value.` },
            requests: [],
          });
        }
      });
    }
  }
});

/** A corpus with one record whose archived bytes are present, so it can be frozen. */
function seedOneRecord(corpus: string): void {
  const store = new FileStore(corpus);
  const sha256 = store.putBlob(Buffer.from("%PDF-1.4 stand-in"));
  const record = sampleRecord({
    source_documents: [
      { role: "combined_pdf", url: "https://example.invalid/19-12345.pdf", sha256, retrieved_at: "2024-04-02T10:14:00Z", url_stable: true },
    ],
  });
  store.putRecord(record);
  indexRecord(store, record);
  store.flushCatalog();
}

const BLANK = "Expected a non-empty value.";

/** Both sides refused the input with the same reason, and neither made a request. */
function bothRefused(result: Awaited<ReturnType<typeof parity>>, name: string, reason: string): void {
  strictEqual(result.cli.code, EXIT_USAGE, result.cli.err);
  ok(result.cli.err.includes(reason), result.cli.err);
  deepStrictEqual(result.cli.requests, []);
  deepStrictEqual(result.lib, { ok: false, error: { name: "OpenKaValidationError", message: `Invalid ${name}: ${reason}` }, requests: [] });
}

describe("blank and unsafe factory parameters (finding 24)", () => {
  it("refuses a golden source that is blank or not a safe key, writing nothing on either side", async () => {
    const UNSAFE = "Not a source key: expected lower-case letters, digits, '.', '_' and '-', like berlin.";
    for (const [source, reason] of [["", BLANK], ["  ", BLANK], ["..", UNSAFE], ["Berlin", UNSAFE]] as const) {
      const cliDir = (corpus: string): string => join(corpus, "goldens");
      const result = await parity({
        runner: runFactory,
        seed: seedOneRecord,
        argv: (corpus) => ["--corpus", corpus, "goldens", "add", "berlin-19-12345", "--dir", cliDir(corpus), "--source", source],
        lib: ({ store, corpus }) => addGolden(store, cliDir(corpus), "berlin-19-12345", source),
      });
      bothRefused(result, "source", reason);
    }
  });

  it("refuses a blank fixture directory or note", async () => {
    for (const blank of ["", "  "]) {
      const dir = await parity({
        runner: runFactory,
        seed: seedOneRecord,
        argv: (corpus) => ["--corpus", corpus, "goldens", "add", "berlin-19-12345", "--dir", blank],
        lib: ({ store }) => addGolden(store, blank, "berlin-19-12345", "berlin"),
      });
      bothRefused(dir, "root", BLANK);
      const note = await parity({
        runner: runFactory,
        seed: seedOneRecord,
        argv: (corpus) => ["--corpus", corpus, "goldens", "add", "berlin-19-12345", "--dir", join(corpus, "g"), "--note", blank],
        lib: ({ store, corpus }) => addGolden(store, join(corpus, "g"), "berlin-19-12345", "berlin", { note: blank }),
      });
      bothRefused(note, "note", BLANK);
    }
  });

  it("refuses a blank model name and a model hash that is not 64 hex digits", async () => {
    const vectors = (corpus: string): string => {
      mkdirSync(corpus, { recursive: true });
      const path = join(corpus, "v.jsonl");
      writeFileSync(path, '{"id":"berlin-19-12345","vector":[1,0]}\n');
      return path;
    };
    for (const blank of ["", "  "]) {
      const result = await parity({
        runner: runFactory,
        argv: (corpus) => ["--corpus", corpus, "embed", "--from", vectors(corpus), "--model", blank],
        lib: ({ corpus }) => importEmbeddings(vectors(corpus), { model: blank }),
      });
      bothRefused(result, "model", BLANK);
    }
    const HEX = "Expected a sha256 as 64 hexadecimal digits.";
    for (const [hash, reason] of [["", BLANK], ["  ", BLANK], ["abc", HEX], ["z".repeat(64), HEX]] as const) {
      const result = await parity({
        runner: runFactory,
        argv: (corpus) => ["--corpus", corpus, "embed", "--from", vectors(corpus), "--model", "m", "--model-sha256", hash],
        lib: ({ corpus }) => importEmbeddings(vectors(corpus), { model: "m", modelSha256: hash }),
      });
      bothRefused(result, "modelSha256", reason);
    }
  });

  it("refuses a blank baseline path, on save and on load", async () => {
    const snapshot = { taken_at: "2026-01-02T03:04:05Z", records: 0, sources: [] };
    for (const blank of ["", "  "]) {
      const load = await parity({
        runner: runFactory,
        argv: (corpus) => ["--corpus", corpus, "drift", "--baseline", blank],
        lib: () => loadBaseline(blank),
      });
      bothRefused(load, "baseline path", BLANK);
      const save = await parity({
        runner: runFactory,
        argv: (corpus) => ["--corpus", corpus, "health", "--save-baseline", blank],
        lib: () => saveBaseline(blank, snapshot),
      });
      bothRefused(save, "baseline path", BLANK);
      ok(blank === "" || !existsSync(blank), "no blank-named file was written");
    }
  });
});
