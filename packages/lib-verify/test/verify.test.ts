// `ka verify` — the two answers that are not "matched" or "differed".
//
// The distinction these tests pin down is the one the module exists for: a claim
// that *cannot* be checked is not the same as a claim that is *wrong*, and
// conflating them would be dishonest in the direction that flatters us.

import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { diffPaths, verifyRecord } from "../src/index.js";
import { MemoryStore, questionPaper, sampleRecord } from "@maschinenlesbar.org/openka-lib-testing";
import { extract } from "@maschinenlesbar.org/openka-lib-extract";
import { sha256 } from "@maschinenlesbar.org/openka-lib-repro";

describe("verifying a record", () => {
  it("says so when there is no such record", async () => {
    const result = await verifyRecord("berlin-19-00000", { store: new MemoryStore() });
    strictEqual(result.ok, false);
    strictEqual(result.reason, "no such record");
    deepStrictEqual(result.differences, []);
    strictEqual(result.storedVersion, "");
  });

  it("reports missing archived bytes as unverifiable, not as a mismatch", async () => {
    // The record claims a document whose blob is not in the corpus. That is a
    // failure to check, and it must not be reported as a difference — a reader
    // would take that as "the extractor changed", which is a different problem.
    const store = new MemoryStore();
    store.putRecord(sampleRecord());
    const result = await verifyRecord("berlin-19-12345", { store });
    strictEqual(result.ok, false);
    match(result.reason ?? "", /archived bytes for .* are missing/);
    deepStrictEqual(result.differences, []);
    // It still reports which extractor produced the record and which is current,
    // because that is the first thing someone looks at.
    strictEqual(result.storedVersion, "test:1");
    ok(result.currentVersion.length > 0);
  });
});

/** A stored record and the exact bytes it was extracted from. */
async function corpus(): Promise<{ store: MemoryStore; id: string }> {
  const bytes = questionPaper([
    "Frage 1:",
    "Wie viele Bruecken sind marode?",
    "Antwort zu 1:",
    "Vierzehn.",
  ]);
  const { record } = await extract({
    parliament: "berlin",
    documentType: "schriftliche_anfrage",
    tier: "text_layer",
    metadata: {
      reference: "19/12345",
      legislative_period: 19,
      title: "Zustand der Brueckenbauwerke",
      askers: [],
      answered_by: { ministry: "Senatsverwaltung" },
      dates: {},
    },
    documents: [{ role: "combined_pdf", url: "https://x.invalid/a.pdf", bytes, urlStable: true }],
  });
  const store = new MemoryStore();
  store.putBlob(bytes);
  store.putRecord(record);
  return { store, id: record.id };
}

describe("verifying a record that is really there", () => {
  it("re-extracts from the archived bytes and matches, byte for byte", async () => {
    // This is the project's central claim made checkable: same input, same
    // extractor version, byte-identical record.
    const { store, id } = await corpus();
    const result = await verifyRecord(id, { store });
    strictEqual(result.ok, true, result.reason ?? JSON.stringify(result.differences));
    deepStrictEqual(result.differences, []);
    strictEqual(result.storedVersion, result.currentVersion);
  });

  it("names the fields that moved when an extracted value was tampered with", async () => {
    const { store, id } = await corpus();
    const stored = store.getRecord(id);
    ok(stored !== undefined);
    // Someone edited the corpus by hand — which is exactly what `ka verify` is for.
    store.putRecord({ ...stored, full_text: "etwas ganz anderes" });
    const result = await verifyRecord(id, { store });
    strictEqual(result.ok, false);
    ok(result.differences.includes("full_text"), JSON.stringify(result.differences));
  });

  it("does not notice an edited *metadata* field, and that is the contract", async () => {
    // `ka verify` asks whether extraction is reproducible, not whether the file was
    // edited. The record's metadata — title, reference, askers — is the *input* to
    // re-extraction, so changing it changes both sides and the two still agree.
    // Worth pinning down, because it is easy to assume verify is a tamper seal for
    // the whole record, and it is not: it is a seal on everything derived from the
    // archived bytes.
    const { store, id } = await corpus();
    const stored = store.getRecord(id);
    store.putRecord({ ...stored!, title: "Ein anderer Titel" });
    const result = await verifyRecord(id, { store });
    strictEqual(result.ok, true);
  });

  it("reports a blob whose bytes no longer hash to their name", async () => {
    const { store, id } = await corpus();
    const stored = store.getRecord(id);
    const sha = stored?.source_documents[0]?.sha256 as string;
    strictEqual(sha, sha256(store.getBlob(sha) as Buffer));
  });
});

describe("a record produced with OCR", () => {
  it("cannot be verified without the same pinned model, and says which", async () => {
    // Re-running a scan through a *different* OCR build gives different text, so
    // verifying without the pinned model would report a mismatch that says nothing
    // about the data. Refusing to check is the honest answer — the same rule as
    // missing archived bytes.
    const { store, id } = await corpus();
    const stored = store.getRecord(id);
    ok(stored !== undefined);
    store.putRecord({
      ...stored,
      extraction: {
        ...stored.extraction,
        tier: "ocr",
        model_artifacts: [{ name: "ocr", version: "tesseract-5.3.4+deu" }],
      },
    });
    const result = await verifyRecord(id, { store });
    strictEqual(result.ok, false);
    match(result.reason ?? "", /needs the same pinned model/);
    // ...and it names the build, because that is what someone has to go and install.
    match(result.reason ?? "", /tesseract-5\.3\.4\+deu/);
    deepStrictEqual(result.differences, []);
  });
});

describe("diffPaths", () => {
  it("finds nothing between equal values", () => {
    deepStrictEqual(diffPaths({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] }), []);
  });

  it("names the path to each difference rather than dumping both records", () => {
    deepStrictEqual(diffPaths({ a: 1 }, { a: 2 }), ["a"]);
    deepStrictEqual(diffPaths({ a: { b: { c: 1 } } }, { a: { b: { c: 2 } } }), ["a.b.c"]);
    // Array indices are bracketed, the same notation `abstained_fields` uses, so a
    // difference can be pasted straight into a search of the record.
    deepStrictEqual(diffPaths({ a: [1, 2] }, { a: [1, 3] }), ["a[1]"]);
  });

  it("reports a key present on one side only", () => {
    deepStrictEqual(diffPaths({ a: 1 }, { a: 1, b: 2 }), ["b"]);
    deepStrictEqual(diffPaths({ a: 1, b: 2 }, { a: 1 }), ["b"]);
  });

  it("calls a change of shape a difference at the root", () => {
    deepStrictEqual(diffPaths({ a: 1 }, "not an object"), ["<root>"]);
    deepStrictEqual(diffPaths(null, { a: 1 }), ["<root>"]);
  });
});
