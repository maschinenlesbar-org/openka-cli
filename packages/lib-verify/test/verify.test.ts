// `ka verify` — the two answers that are not "matched" or "differed".
//
// The distinction these tests pin down is the one the module exists for: a claim
// that *cannot* be checked is not the same as a claim that is *wrong*, and
// conflating them would be dishonest in the direction that flatters us.

import { deepStrictEqual, match, ok, rejects, strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_VERIFY_SAMPLE,
  UNCHECKED_FIELDS,
  VersionOnlyError,
  assertVerified,
  diffPaths,
  evenSample,
  compareQa,
  reextractRecords,
  verifyCorpus,
  verifyRecord,
} from "../src/index.js";
import { FileStore } from "@maschinenlesbar.org/openka-lib-store";
import { CorpusLockedError, OpenKaError, OpenKaValidationError, StoreError } from "@maschinenlesbar.org/openka-lib-errors";
import type { KaRecord } from "@maschinenlesbar.org/openka-lib-models";
import { MemoryStore, questionPaper, sampleRecord } from "@maschinenlesbar.org/openka-lib-testing";
import { extract } from "@maschinenlesbar.org/openka-lib-extract";
import { extractorVersion, sha256 } from "@maschinenlesbar.org/openka-lib-repro";

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
async function corpus(
  metadata: { askers?: { name: string; party?: string }[]; dates?: { submitted?: string } } = {},
): Promise<{ store: MemoryStore; id: string }> {
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
      askers: metadata.askers ?? [],
      answered_by: { ministry: "Senatsverwaltung" },
      dates: metadata.dates ?? {},
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

  it("says which fields it could not check, and each of them really passes edited", async () => {
    // The report used to say "reproduced byte-identically" and nothing else, so an
    // SPD member's question rewritten as asked by "Max Mustermann (AfD)" read as
    // verified. Every field in UNCHECKED_FIELDS must be one an edit gets past —
    // otherwise the list overstates the gap.
    const { store, id } = await corpus({ askers: [{ name: "Eva von Angern", party: "Die Linke" }], dates: { submitted: "2024-03-01" } });
    const stored = store.getRecord(id);
    ok(stored !== undefined && stored.source_documents[0] !== undefined);
    const document = stored.source_documents[0];
    const edits: Record<(typeof UNCHECKED_FIELDS)[number], Partial<typeof stored>> = {
      title: { title: "Ein anderer Titel" },
      askers: { askers: [{ name: "Max Mustermann", party: "AfD" }] },
      answered_by: { answered_by: { ministry: "Senatsverwaltung für Erfindungen" } },
      dates: { dates: { ...stored.dates, submitted: "2024-02-01" } },
      "source_documents[].url": { source_documents: [{ ...document, url: "https://example.org/x.pdf" }] },
      "source_documents[].role": { source_documents: [{ ...document, role: "combined_pdf" }] },
      "source_documents[].url_stable": { source_documents: [{ ...document, url_stable: !document.url_stable }] },
      "source_documents[].retrieved_at": { source_documents: [{ ...document, retrieved_at: "2026-01-02T00:00:00Z" }] },
    };
    for (const [field, edit] of Object.entries(edits)) {
      store.putRecord({ ...stored, ...edit });
      const result = await verifyRecord(id, { store });
      strictEqual(result.ok, true, `${field}: ${JSON.stringify(result.differences)}`);
    }
    store.putRecord(stored);
    const report = await verifyCorpus({ store, ids: [id] });
    deepStrictEqual(report.unchecked, [...UNCHECKED_FIELDS]);
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

describe("a record that cannot be read", () => {
  it("is a failed row marked unreadable, not a throw that stops the caller", async () => {
    const root = mkdtempSync(join(tmpdir(), "openka-verify-"));
    try {
      const store = new FileStore(root);
      store.putRecord(sampleRecord());
      writeFileSync(join(root, "records", "berlin-19-12345.json"), '{"broken');
      const result = await verifyRecord("berlin-19-12345", { store, env: {} });
      deepStrictEqual(result, {
        id: "berlin-19-12345",
        ok: false,
        verdict: "unreadable",
        unreadable: true,
        reason: "Corrupt record berlin-19-12345",
        differences: [],
        contentDifferences: [],
        storedVersion: "unknown",
        currentVersion: extractorVersion({}),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("verifying a corpus", () => {
  const ids = [
    ...Array.from({ length: 15 }, (_, i) => `berlin-19-${i}`),
    ...Array.from({ length: 15 }, (_, i) => `sachsen-8-${i}`),
    ...Array.from({ length: 15 }, (_, i) => `thueringen-8-${i}`),
  ];

  it("samples across the corpus rather than one alphabetical prefix", () => {
    // Record ids sort by parliament, so `slice(0, n)` checked the same first
    // records every run and whole Länder were never verified.
    const sample = evenSample(ids, DEFAULT_VERIFY_SAMPLE);
    strictEqual(sample.length, 25);
    for (const parliament of ["berlin", "sachsen", "thueringen"]) {
      ok(sample.some((id: string) => id.startsWith(parliament)), `${parliament} missing from the sample`);
    }
    // Deterministic: a reproducibility check must pick the same records each run.
    deepStrictEqual(evenSample(ids, 25), sample);
    deepStrictEqual(evenSample(ids, 100), ids);
  });

  it("checks every record past a corrupt one and tallies the unreadable", async () => {
    const root = mkdtempSync(join(tmpdir(), "openka-verify-"));
    try {
      const store = new FileStore(root);
      for (const n of ["1", "2", "3"]) store.putRecord(sampleRecord({ id: `berlin-19-${n}`, reference: `19/${n}` }));
      writeFileSync(join(root, "records", "berlin-19-2.json"), '{"broken');
      const report = await verifyCorpus({ store, env: {}, all: true });
      // One corrupt record file, and two records whose archived bytes were never
      // stored here — all three a damaged corpus, not a mismatch (finding 02#6).
      deepStrictEqual([report.checked, report.unreadable], [3, 3]);
      match(report.results[0]?.reason ?? "", /archived bytes .* are missing/);
      deepStrictEqual(report.results.map((result) => result.id), ["berlin-19-1", "berlin-19-2", "berlin-19-3"]);
      strictEqual(report.reproduced, report.results.filter((result) => result.ok).length);
      throws(() => assertVerified(report), (error: unknown) =>
        error instanceof StoreError && error.message === "3 record(s) did not reproduce, 3 of them unreadable");

      const one = await verifyCorpus({ store, env: {}, ids: ["berlin-19-1"] });
      deepStrictEqual(one.results.map((result) => result.id), ["berlin-19-1"]);
      const sampled = await verifyCorpus({ store, env: {}, limit: 2 });
      deepStrictEqual(sampled.results.map((result) => result.id), evenSample(store.recordIds(), 2));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("gives a verdict: a mismatch fails, a version stamp alone is its own verdict, a clean report passes", () => {
    const row = { id: "x", differences: [], contentDifferences: [], storedVersion: "v", currentVersion: "v" };
    const tally = { unreadable: 0, unchecked: [] };
    throws(
      () => assertVerified({ ...tally, checked: 2, reproduced: 0, versionOnly: 1, differs: 1, results: [{ ...row, ok: false, verdict: "differs" }, { ...row, ok: false, verdict: "version-only" }] }),
      (error: unknown) => error instanceof OpenKaError && !(error instanceof VersionOnlyError) && !(error instanceof StoreError) && error.message === "1 record(s) did not reproduce",
    );
    throws(
      () => assertVerified({ ...tally, checked: 1, reproduced: 0, versionOnly: 1, differs: 0, results: [{ ...row, ok: false, verdict: "version-only" }] }),
      (error: unknown) => error instanceof VersionOnlyError && /1 record\(s\) reproduce in content but were stamped by another extractor version; `ka reextract` restamps them/.test((error as Error).message),
    );
    assertVerified({ ...tally, checked: 1, reproduced: 1, versionOnly: 0, differs: 0, results: [{ ...row, ok: true, verdict: "reproduced" }] });
  });

  it("refuses an empty corpus and a sample size below one", async () => {
    const store = new MemoryStore();
    await rejects(verifyCorpus({ store, env: {} }), (error: unknown) =>
      error instanceof OpenKaError && error.message === `No records in ${store.root}`);
    await rejects(verifyCorpus({ store, env: {}, limit: 0 }), (error: unknown) =>
      error instanceof OpenKaValidationError && error.message === "Invalid limit: Must be >= 1.");
  });
});

// Issue #13: after an upgrade every record carried the old extractor's stamp and
// `ka verify` failed on all of them, without saying whether the content had moved.
describe("a record stamped by another build", () => {
  const OLD = "pkg:0.2.0+extract:6f021d93d3c3";
  const restamp = (store: MemoryStore, id: string, change: (record: KaRecord) => KaRecord = (record) => record): void => {
    const stored = store.getRecord(id) as KaRecord;
    store.putRecord(change({ ...stored, extraction: { ...stored.extraction, extractor_version: OLD } }));
  };

  it("verifies the content anyway: version-only when it reproduces, differs with the paths when it does not", async () => {
    const { store, id } = await corpus();
    restamp(store, id);
    const same = await verifyRecord(id, { store, env: {} });
    deepStrictEqual([same.ok, same.verdict, same.differences, same.contentDifferences], [false, "version-only", ["extraction.extractor_version"], []]);
    strictEqual(same.reason, `produced by ${OLD}, content identical under ${extractorVersion({})}`);

    restamp(store, id, (record) => ({ ...record, full_text: "etwas ganz anderes" }));
    const moved = await verifyRecord(id, { store, env: {} });
    deepStrictEqual([moved.verdict, moved.contentDifferences], ["differs", ["full_text"]]);
    const report = await verifyCorpus({ store, env: {}, all: true });
    deepStrictEqual([report.versionOnly, report.differs], [0, 1]);
  });

  it("is brought up to this build by reextractRecords, from the archived bytes, and then verifies", async () => {
    const { store, id } = await corpus();
    restamp(store, id);
    const dry = await reextractRecords({ store, env: {}, ids: [id], dryRun: true });
    deepStrictEqual([dry.counts["unchanged-content"], dry.written, dry.reindexed], [1, 0, false]);
    strictEqual(store.getRecord(id)?.extraction.extractor_version, OLD, "a dry run writes nothing");

    const report = await reextractRecords({ store, env: {}, ids: [id] });
    deepStrictEqual([report.results[0]?.outcome, report.written, report.reindexed], ["unchanged-content", 1, true]);
    strictEqual(store.getRecord(id)?.extraction.extractor_version, extractorVersion({}));
    strictEqual(store.catalogEntry(id)?.id, id, "the catalog is rebuilt");
    strictEqual((await verifyRecord(id, { store, env: {} })).verdict, "reproduced");

    // Stamped by this build now: left alone, unless forced — and then nothing moves.
    deepStrictEqual((await reextractRecords({ store, env: {}, ids: [id] })).counts.current, 1);
    const forced = await reextractRecords({ store, env: {}, ids: [id], force: true });
    deepStrictEqual([forced.results[0]?.outcome, forced.written], ["identical", 0]);
  });

  it("names what moved, what it resolved and what it newly abstains on", async () => {
    const { store, id } = await corpus();
    const fresh = store.getRecord(id) as KaRecord;
    const holes = fresh.extraction.abstained_fields;
    ok(holes.length > 0, "the fixture leaves askers and dates open");
    // Stored by a build that could not read the answer: the new one can.
    restamp(store, id, (record) => ({ ...record, full_text: "alt", extraction: { ...record.extraction, abstained_fields: [...holes, "qa[0].answer"] } }));
    const report = await reextractRecords({ store, env: {}, ids: [id] });
    const result = report.results[0];
    strictEqual(result?.outcome, "changed");
    ok(result?.differences.includes("full_text"), JSON.stringify(result?.differences));
    deepStrictEqual([result?.resolved, result?.abstained], [["qa[0].answer"], []]);
    deepStrictEqual(store.getRecord(id), fresh, "stored as this build extracts it");

    // Stored by a build that filled what this one leaves open: newly abstained.
    restamp(store, id, (record) => ({ ...record, extraction: { ...record.extraction, abstained_fields: [] } }));
    deepStrictEqual((await reextractRecords({ store, env: {}, ids: [id] })).results[0]?.abstained, holes);
  });

  it("keeps a person's mark where the content did not move, and drops it where it did", async () => {
    const { store, id } = await corpus();
    restamp(store, id, (record) => ({ ...record, extraction: { ...record.extraction, review_status: "human_verified" } }));
    const kept = await reextractRecords({ store, env: {}, ids: [id] });
    deepStrictEqual([kept.results[0]?.outcome, kept.results[0]?.droppedMark, store.getRecord(id)?.extraction.review_status], ["unchanged-content", undefined, "human_verified"]);

    restamp(store, id, (record) => ({ ...record, full_text: "alt", extraction: { ...record.extraction, review_status: "human_verified" } }));
    const dropped = await reextractRecords({ store, env: {}, ids: [id] });
    deepStrictEqual([dropped.results[0]?.outcome, dropped.results[0]?.droppedMark], ["changed", true]);
    ok(store.getRecord(id)?.extraction.review_status !== "human_verified");
  });

  it("goes past a record it cannot read, and takes the corpus lock while it writes", async () => {
    const { store, id } = await corpus();
    restamp(store, id);
    store.putRecord(sampleRecord({ id: "berlin-19-99999", reference: "19/99999" }));
    const report = await reextractRecords({ store, env: {}, ids: ["berlin-19-99999", id] });
    deepStrictEqual([report.results.map((result) => result.outcome), report.counts.unreadable], [["unreadable", "unchanged-content"], 1]);
    match(report.results[0]?.reason ?? "", /archived bytes .* are missing/);

    const root = mkdtempSync(join(tmpdir(), "openka-reextract-"));
    try {
      const files = new FileStore(root);
      files.putRecord(sampleRecord());
      const release = new FileStore(root).lock("sync --source berlin");
      await rejects(reextractRecords({ store: files, env: {}, ids: ["berlin-19-12345"] }), CorpusLockedError);
      await reextractRecords({ store: files, env: {}, ids: ["berlin-19-12345"], dryRun: true });
      release();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("a record an earlier build filed under another paper's id (issue #25)", () => {
  /** KA 8/1487 as 0.6.0 stored it: read as Drucksache 08/1487, a question date, no answer, no document. */
  const filedAsDrucksache = (overrides: Partial<KaRecord> = {}): KaRecord =>
    sampleRecord({
      id: "sachsen-anhalt-8-1487",
      parliament: "sachsen-anhalt",
      document_type: "kleine_anfrage",
      reference: "08/1487",
      legislative_period: 8,
      dates: { submitted: "2023-05-19" },
      source_documents: [],
      ...overrides,
    });

  it("moves to its own id, and is named on a dry run first", async () => {
    const store = new MemoryStore();
    store.putRecord(filedAsDrucksache());
    const dry = await reextractRecords({ store, env: {}, ids: ["sachsen-anhalt-8-1487"], dryRun: true });
    deepStrictEqual([dry.moved, dry.results[0]?.movedTo, store.hasRecord("sachsen-anhalt-8-1487")], [1, "sachsen-anhalt-8-ka-1487", true]);

    const report = await reextractRecords({ store, env: {}, ids: ["sachsen-anhalt-8-1487"] });
    deepStrictEqual([report.moved, report.written, report.reindexed], [1, 1, true]);
    strictEqual(store.hasRecord("sachsen-anhalt-8-1487"), false);
    const moved = store.getRecord("sachsen-anhalt-8-ka-1487");
    deepStrictEqual([moved?.reference, moved?.dates], ["KA 8/1487", { submitted: "2023-05-19" }]);
    ok(store.catalogEntry("sachsen-anhalt-8-ka-1487") !== undefined && store.catalogEntry("sachsen-anhalt-8-1487") === undefined);
    // Moved even when stamped by this build already: the id is wrong, whatever the stamp.
    store.putRecord(filedAsDrucksache({ extraction: { ...filedAsDrucksache().extraction, extractor_version: extractorVersion({}) } }));
    strictEqual((await reextractRecords({ store, env: {}, ids: ["sachsen-anhalt-8-1487"] })).counts.duplicate, 1);
  });

  it("is removed as a stale copy when its own id is taken, and leaves an answered Drucksache alone", async () => {
    const store = new MemoryStore();
    store.putRecord(filedAsDrucksache());
    store.putRecord(filedAsDrucksache({ id: "sachsen-anhalt-8-ka-1487", reference: "KA 8/1487" }));
    store.putRecord(filedAsDrucksache({ id: "sachsen-anhalt-8-1488", reference: "08/1488", dates: { answered: "2022-06-01" } }));
    const report = await reextractRecords({ store, env: {}, ids: ["sachsen-anhalt-8-1487", "sachsen-anhalt-8-1488"] });
    deepStrictEqual(report.results.map((result) => [result.id, result.outcome, result.movedTo]), [
      ["sachsen-anhalt-8-1487", "duplicate", "sachsen-anhalt-8-ka-1487"],
      ["sachsen-anhalt-8-1488", "changed", undefined],
    ]);
    deepStrictEqual(store.recordIds(), ["sachsen-anhalt-8-1488", "sachsen-anhalt-8-ka-1487"]);
  });

  it("keeps a person's mark when only its name moves", async () => {
    const store = new MemoryStore();
    store.putRecord(filedAsDrucksache());
    await reextractRecords({ store, env: {}, ids: ["sachsen-anhalt-8-1487"] });
    // The record as this build extracts it, back under its old name and checked by a person.
    const current = store.getRecord("sachsen-anhalt-8-ka-1487") as KaRecord;
    store.deleteRecord(current.id);
    store.putRecord({ ...current, id: "sachsen-anhalt-8-1487", reference: "08/1487", extraction: { ...current.extraction, review_status: "human_verified" } });
    const report = await reextractRecords({ store, env: {}, ids: ["sachsen-anhalt-8-1487"] });
    deepStrictEqual([report.results[0]?.movedTo, report.results[0]?.droppedMark], ["sachsen-anhalt-8-ka-1487", undefined]);
    strictEqual(store.getRecord("sachsen-anhalt-8-ka-1487")?.extraction.review_status, "human_verified");
  });
});

describe("comparing a re-extraction's Q/A by number (issue #26)", () => {
  it("names what moved by question number, not by the index a new pair shifts", () => {
    const before = sampleRecord({
      qa: [
        { number: "1", question: "Wie viele?", answer: "Vierzehn." },
        { number: "2", question: "Wo?" },
      ],
    });
    const after = sampleRecord({
      qa: [
        { number: "1", question: "Wie viele?", answer: "Vierzehn." },
        { number: "1a", question: "Und davon?" },
        { number: "2", answer: "In Pankow." },
      ],
    });
    deepStrictEqual(compareQa(before, after), {
      before: { pairs: 2, questions: 2, answers: 1 },
      after: { pairs: 3, questions: 2, answers: 2 },
      gained: ["1a", "1a.question", "2.answer"],
      lost: ["2.question"],
    });
  });
});
