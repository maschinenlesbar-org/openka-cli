// CLI <-> library parity: the same input through `run()` and through the library
// function the CLI wraps must give the same outcome. Each `describe` below pins one
// rule that used to live only in a commander parser or a command action.

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
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
