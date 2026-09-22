// The OCR seam — the one place a model may run on the line (CONCEPT.md §6).
//
// No real OCR happens here and none should: these tests drive the seam with a stub
// `tesseract` on disk and an injected `tesseract.js` module, because what needs
// pinning down is not whether Tesseract can read a scan. It is the four rules the
// seam exists to enforce — a pinned version, hashed weights, no silent guessing,
// and an abstention whenever any of that cannot be honoured.

import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TesseractCliPerceiver, TesseractJsPerceiver, abstainingPerceiver } from "../src/index.js";

const page = { data: Buffer.from("not really an image"), format: "jpeg", page: 3 };

/** A stub `tesseract` that answers --version, --list-langs and a recognition run. */
function stubTesseract(options: { version?: string; text?: string; fail?: boolean } = {}): {
  dir: string;
  binary: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "openka-ocr-"));
  writeFileSync(join(dir, "deu.traineddata"), "weights");
  const script = `#!/bin/sh
case "$1" in
  --version) echo "tesseract ${options.version ?? "5.3.4"}"; echo " leptonica-1.84.1"; exit 0 ;;
  --list-langs) echo 'List of available languages in "${dir}" (1):'; echo deu; exit 0 ;;
esac
${options.fail === true ? 'echo "Error in pixReadStream" >&2; exit 1' : `printf '%s' '${options.text ?? "Erkannter Text"}'`}
`;
  const binary = join(dir, "tesseract");
  writeFileSync(binary, script);
  chmodSync(binary, 0o755);
  return { dir, binary, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("strict mode", () => {
  it("abstains on every page and says why", async () => {
    strictEqual(abstainingPerceiver.available(), true);
    deepStrictEqual(abstainingPerceiver.artifact(), { name: "none", version: "strict-mode" });
    const out = await abstainingPerceiver.recognize(page);
    strictEqual(out.abstained, true);
    strictEqual(out.text, "");
    match(out.reason ?? "", /strict mode: no OCR model is enabled, page 3 not read/);
  });
});

describe("the Tesseract binary, when it is not there", () => {
  const missing = new TesseractCliPerceiver({ binary: "openka-no-such-tesseract" });

  it("is unavailable rather than throwing", () => {
    strictEqual(missing.available(), false);
    strictEqual(missing.version(), undefined);
  });

  it("refuses to describe a run it cannot make", () => {
    // `artifact()` is what goes into the record's provenance. Inventing one for a
    // binary that is not installed would be a claim about a run that never happened.
    try {
      missing.artifact();
      ok(false, "expected artifact() to throw");
    } catch (err) {
      match((err as Error).message, /is not available/);
    }
  });

  it("abstains instead of producing an empty page", async () => {
    const out = await missing.recognize(page);
    strictEqual(out.abstained, true);
    match(out.reason ?? "", /tesseract not on PATH; page 3 not read/);
  });
});

describe("the Tesseract binary, with one on PATH", () => {
  it("reads its version and hashes the weights it found", () => {
    const stub = stubTesseract({ version: "5.3.4" });
    try {
      const perceiver = new TesseractCliPerceiver({ binary: stub.binary });
      strictEqual(perceiver.available(), true);
      strictEqual(perceiver.version(), "5.3.4");
      const artifact = perceiver.artifact();
      strictEqual(artifact.name, "ocr");
      strictEqual(artifact.version, "tesseract-5.3.4+deu");
      // Two `deu` builds give different text, so a record naming only the binary
      // version claims a provenance it does not have.
      match(artifact.weights_sha256 ?? "", /^[0-9a-f]{64}$/);
    } finally {
      stub.cleanup();
    }
  });

  it("refuses a version the corpus did not pin", () => {
    const stub = stubTesseract({ version: "5.3.4" });
    try {
      const perceiver = new TesseractCliPerceiver({ binary: stub.binary, requireVersion: "5.0.0" });
      try {
        perceiver.artifact();
        ok(false, "expected a version mismatch");
      } catch (err) {
        match((err as Error).message, /pins 5\.0\.0, the binary on PATH is 5\.3\.4/);
        match((err as Error).message, /not interchangeable/);
      }
    } finally {
      stub.cleanup();
    }
  });

  it("refuses when the traineddata it was pointed at is not there", () => {
    const stub = stubTesseract();
    try {
      const perceiver = new TesseractCliPerceiver({
        binary: stub.binary,
        traineddataPath: join(stub.dir, "absent.traineddata"),
      });
      try {
        perceiver.artifact();
        ok(false, "expected a missing-traineddata error");
      } catch (err) {
        match((err as Error).message, /Traineddata not found/);
      }
    } finally {
      stub.cleanup();
    }
  });

  it("returns the text it read", async () => {
    const stub = stubTesseract({ text: "Erkannter Text" });
    try {
      const out = await new TesseractCliPerceiver({ binary: stub.binary }).recognize(page);
      strictEqual(out.abstained, false);
      strictEqual(out.text, "Erkannter Text");
    } finally {
      stub.cleanup();
    }
  });

  it("abstains when the binary fails, quoting its first line of stderr", async () => {
    const stub = stubTesseract({ fail: true });
    try {
      const out = await new TesseractCliPerceiver({ binary: stub.binary }).recognize(page);
      strictEqual(out.abstained, true);
      match(out.reason ?? "", /tesseract failed on page 3 \(jpeg\): Error in pixReadStream/);
    } finally {
      stub.cleanup();
    }
  });

  it("abstains when it produced nothing, rather than reporting an empty page", async () => {
    const stub = stubTesseract({ text: "" });
    try {
      const out = await new TesseractCliPerceiver({ binary: stub.binary }).recognize(page);
      strictEqual(out.abstained, true);
      match(out.reason ?? "", /produced no text for page 3/);
    } finally {
      stub.cleanup();
    }
  });
});

describe("tesseract.js, the optional peer", () => {
  const fake = (text: string): { recognize: () => Promise<{ data: { text: string } }> } => ({
    recognize: async () => ({ data: { text } }),
  });

  it("is unavailable until loaded, and abstains rather than failing the sync", async () => {
    // Nothing installs tesseract.js, so this is the state a normal corpus is in.
    const perceiver = new TesseractJsPerceiver();
    strictEqual(perceiver.available(), false);
    strictEqual(await perceiver.load(), false);
    const out = await perceiver.recognize(page);
    strictEqual(out.abstained, true);
    match(out.reason ?? "", /tesseract\.js is not installed; page 3 not read/);
  });

  it("refuses to describe a run when the module is not installed", () => {
    try {
      new TesseractJsPerceiver().artifact();
      ok(false, "expected artifact() to throw");
    } catch (err) {
      match((err as Error).message, /tesseract\.js is not installed/);
    }
  });

  it("describes the run when a module is supplied", async () => {
    const perceiver = new TesseractJsPerceiver({ module: fake("Aus dem Scan"), moduleVersion: "5.1.1" });
    strictEqual(perceiver.available(), true);
    deepStrictEqual(perceiver.artifact(), { name: "ocr", version: "tesseract.js-5.1.1+deu" });
    const out = await perceiver.recognize(page);
    strictEqual(out.abstained, false);
    strictEqual(out.text, "Aus dem Scan");
  });

  it("refuses a version the corpus did not pin", () => {
    const perceiver = new TesseractJsPerceiver({
      module: fake("x"),
      moduleVersion: "5.1.1",
      requireVersion: "4.0.0",
    });
    try {
      perceiver.artifact();
      ok(false, "expected a version mismatch");
    } catch (err) {
      match((err as Error).message, /pins 4\.0\.0, the installed module is 5\.1\.1/);
    }
  });

  it("abstains on an empty result and on a thrown one", async () => {
    const empty = new TesseractJsPerceiver({ module: fake("   "), moduleVersion: "5.1.1" });
    const emptyOut = await empty.recognize(page);
    strictEqual(emptyOut.abstained, true);
    match(emptyOut.reason ?? "", /produced no text for page 3/);

    const broken = new TesseractJsPerceiver({
      module: { recognize: async () => { throw new Error("wasm out of memory"); } },
      moduleVersion: "5.1.1",
    });
    const brokenOut = await broken.recognize(page);
    strictEqual(brokenOut.abstained, true);
    match(brokenOut.reason ?? "", /tesseract\.js failed on page 3: wasm out of memory/);
  });
});
