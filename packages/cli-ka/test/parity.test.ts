// CLI <-> library parity: the same input through `run()` and through the library
// function the CLI wraps must give the same outcome. Each `describe` below pins one
// rule that used to live only in a commander parser or a command action.

import { deepStrictEqual, match, ok, strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { CORPUS_ENV, FileStore, archivedDocument, corpusStats, indexRecord, markHumanVerified, resolveCorpusRoot } from "@maschinenlesbar.org/openka-lib-store";
import { sourceStatus, sync, syncSources } from "@maschinenlesbar.org/openka-lib-pipeline";
import { SOURCE_REGISTRY, createSource, sourceKeys } from "@maschinenlesbar.org/openka-lib-registry";
import { FetchEngine, MAX_HOST_INTERVAL_MS, MAX_REDIRECTS, MAX_RETRIES, MIN_RESPONSE_BYTES, type Transport } from "@maschinenlesbar.org/openka-lib-http";
import { fixturesOf, sampleRecord } from "@maschinenlesbar.org/openka-lib-testing";
import {
  BASELINE_FILE,
  DEFAULT_DIMENSIONS,
  MAX_DIMENSIONS,
  MIN_DIMENSIONS,
  addGolden,
  assertGoldensPass,
  baselinePath,
  buildEmbeddings,
  detectDrift,
  importEmbeddings,
  lintLine,
  listAllGoldens,
  listGoldens,
  loadBaseline,
  loadCorpusBaseline,
  measureHealth,
  saveBaseline,
  saveCorpusBaseline,
  sweepAnswers,
  verifyGoldens,
} from "@maschinenlesbar.org/openka-cli-ka-factory";
import { reviewQueue, search, searchLike, selectRecords, type SearchFilters } from "@maschinenlesbar.org/openka-lib-search";
import { renderAtom, renderJsonLines, renderRecord } from "@maschinenlesbar.org/openka-lib-render";
import { canonicalJsonLine } from "@maschinenlesbar.org/openka-lib-repro";
import { assertVerified, verifyCorpus, verifyRecord } from "@maschinenlesbar.org/openka-lib-verify";
import { rmSync } from "node:fs";
import { OpenKaValidationError, UsageError } from "@maschinenlesbar.org/openka-lib-errors";
import { runFactory } from "@maschinenlesbar.org/openka-cli-ka-factory";
import { EXIT_STORE, EXIT_USAGE, run } from "../src/run.js";
import { TesseractCliPerceiver, TesseractJsPerceiver, createPerceiver } from "@maschinenlesbar.org/openka-lib-perceive";
import { cliHarness } from "./harness.js";
import { parity } from "./helpers.js";

describe("a validation error raised inside an action", () => {
  const refusing = (): never => {
    throw new OpenKaValidationError("Invalid corpus: Expected a non-empty value.", { reason: "Expected a non-empty value." });
  };

  it("exits 2 from ka, printed as Error: <message>", async () => {
    const harness = cliHarness();
    harness.deps.openStore = refusing;
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
        lib: ({ store, corpus }) => addGolden(store, "berlin-19-12345", { root: cliDir(corpus), source }),
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
        lib: ({ store }) => addGolden(store, "berlin-19-12345", { root: blank, source: "berlin" }),
      });
      bothRefused(dir, "root", BLANK);
      const note = await parity({
        runner: runFactory,
        seed: seedOneRecord,
        argv: (corpus) => ["--corpus", corpus, "goldens", "add", "berlin-19-12345", "--dir", join(corpus, "g"), "--note", blank],
        lib: ({ store, corpus }) => addGolden(store, "berlin-19-12345", { root: join(corpus, "g"), source: "berlin", note: blank }),
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

describe("the feed's newest-first selection and the export set (finding 8)", () => {
  /** 26 records — more than search()'s default page — with answers on different days. */
  function seedDated(corpus: string): void {
    const store = new FileStore(corpus);
    for (let n = 1; n <= 26; n++) {
      const day = String(((n * 7) % 28) + 1).padStart(2, "0");
      const record = sampleRecord({
        id: `berlin-19-${String(n).padStart(5, "0")}`,
        reference: `19/${String(n).padStart(5, "0")}`,
        dates: { submitted: "2024-01-01", answered: `2024-${n % 2 === 0 ? "05" : "02"}-${day}` },
      });
      store.putRecord(record);
      indexRecord(store, record);
    }
    store.flushCatalog();
  }
  const updated = "2026-01-02T03:04:05Z";
  // JSON Lines: every line one whole record (finding 02#2 — it used to be the
  // pretty-printed form, ~80 lines a record).
  const exportedIds = (jsonl: string): string[] =>
    jsonl.split("\n").filter((line) => line !== "").map((line) => (JSON.parse(line) as { id: string }).id);

  it("builds the same feed as renderAtom over selectRecords", async () => {
    for (const extra of [[], ["--parliament", "berlin"], ["--query", "Brücken"]]) {
      const result = await parity({
        seed: seedDated,
        argv: (corpus) => ["--corpus", corpus, "feed", "--limit", "3", ...extra],
        lib: ({ store }) =>
          renderAtom(
            selectRecords(store, extra[0] === "--query" ? "Brücken" : "", extra[0] === "--parliament" ? { parliament: ["berlin"] } : {}).records,
            { title: "OpenKA — Kleine Anfragen", id: "urn:openka:feed", updated, limit: 3 },
          ),
      });
      strictEqual(result.cli.code, 0, result.cli.err);
      ok(result.lib.ok);
      strictEqual(result.cli.out + "\n", result.lib.value);
    }
  });

  it("exports every match, the same set selectRecords returns", async () => {
    const result = await parity({
      seed: seedDated,
      argv: (corpus) => ["--corpus", corpus, "export", "--format", "jsonl"],
      lib: ({ store }) => renderJsonLines(selectRecords(store, "").records).replace(/\n$/, ""),
    });
    strictEqual(result.cli.code, 0, result.cli.err);
    ok(result.lib.ok);
    strictEqual(result.cli.out, result.lib.value);
    strictEqual(exportedIds(result.cli.out).length, 26);
  });

  it("says which catalog rows had no record file, where the library names them", async () => {
    const seedWithHole = (corpus: string): void => {
      seedDated(corpus);
      rmSync(join(corpus, "records", "berlin-19-00002.json"));
    };
    const result = await parity({
      seed: seedWithHole,
      argv: (corpus) => ["--corpus", corpus, "export", "--format", "jsonl"],
      lib: ({ store }) => selectRecords(store, "").missing,
    });
    strictEqual(result.cli.code, 0, result.cli.err);
    deepStrictEqual(result.lib, { ok: true, value: ["berlin-19-00002"], requests: [] });
    ok(result.cli.err.includes("berlin-19-00002"), result.cli.err);
    strictEqual(exportedIds(result.cli.out).length, 25);
  });
});

describe("the review queue and the human_verified mark (finding 9)", () => {
  function seedQueue(corpus: string): void {
    const store = new FileStore(corpus);
    const abstaining = (id: string, reference: string, period: number, fields: string[]) =>
      sampleRecord({
        id,
        parliament: id.split("-")[0] as ReturnType<typeof sampleRecord>["parliament"],
        reference,
        legislative_period: period,
        qa: [],
        ...(fields.includes("answered_by.ministry") ? { answered_by: {} } : {}),
        extraction: { ...sampleRecord().extraction, parse_complete: false, abstained_fields: fields, review_status: "needs_review" },
      });
    for (const record of [
      sampleRecord(),
      abstaining("berlin-19-12346", "19/12346", 19, ["qa"]),
      abstaining("berlin-19-12347", "19/12347", 19, ["answered_by.ministry", "markers", "qa"]),
      abstaining("bayern-18-00001", "18/00001", 18, ["markers", "qa"]),
    ]) {
      store.putRecord(record);
      indexRecord(store, record);
    }
    store.flushCatalog();
  }

  it("lists the same queue as reviewQueue, filtered and cut the same way", async () => {
    for (const [extra, options] of [
      [[], {}],
      [["--source", "berlin", "--limit", "1"], { parliament: "berlin", limit: 1 }],
    ] as const) {
      const result = await parity({
        seed: seedQueue,
        argv: (corpus) => ["--compact", "--corpus", corpus, "review", "--json", ...extra],
        lib: ({ store }) => {
          const queue = reviewQueue(store, options);
          return { total: queue.total, records: queue.entries };
        },
      });
      strictEqual(result.cli.code, 0, result.cli.err);
      ok(result.lib.ok);
      deepStrictEqual(JSON.parse(result.cli.out), result.lib.value);
    }
  });

  it("marks a record verified in record and catalog alike, as markHumanVerified does", async () => {
    const after = (store: FileStore) => ({
      record: store.getRecord("berlin-19-12346")?.extraction.review_status,
      catalog: store.catalogEntry("berlin-19-12346")?.review_status,
      verified: search(store, "", { reviewStatus: ["human_verified"] }).total,
      queue: reviewQueue(store).entries.map((entry) => entry.id),
    });
    let cliCorpus = "";
    const result = await parity({
      seed: seedQueue,
      argv: (corpus) => {
        cliCorpus = corpus;
        return ["--corpus", corpus, "review", "--mark-verified", "berlin-19-12346"];
      },
      lib: ({ store }) => {
        markHumanVerified(store, "berlin-19-12346");
        // Read both corpora back while they still exist: the CLI's and the library's.
        return { cli: after(new FileStore(cliCorpus)), lib: after(store) };
      },
    });
    strictEqual(result.cli.code, 0, result.cli.err);
    ok(result.lib.ok);
    const expected = { record: "human_verified", catalog: "human_verified", verified: 1, queue: ["berlin-19-12347", "bayern-18-00001"] };
    deepStrictEqual(result.lib.value, { cli: expected, lib: expected });
  });
});

describe("corpus summaries (finding 14)", () => {
  function seedSummary(corpus: string): void {
    const store = new FileStore(corpus);
    const incomplete = sampleRecord({
      id: "berlin-19-22222",
      reference: "19/22222",
      qa: [],
      extraction: { ...sampleRecord().extraction, parse_complete: false, abstained_fields: ["qa"], review_status: "needs_review" },
    });
    const bayern = sampleRecord({ id: "bayern-18-00001", parliament: "bayern", reference: "18/00001", legislative_period: 18 });
    for (const record of [sampleRecord(), incomplete, bayern]) {
      store.putRecord(record);
      indexRecord(store, record);
    }
    store.flushCatalog();
    store.putSourceState({ source: "berlin", last_sync: "2026-01-01T00:00:00Z", last_error: "HTTP 503 from upstream", http_cache: {} });
  }

  it("ka stats prints corpusStats, with the corpus path", async () => {
    let cliCorpus = "";
    const result = await parity({
      seed: seedSummary,
      argv: (corpus) => {
        cliCorpus = corpus;
        return ["--compact", "--corpus", corpus, "stats", "--json"];
      },
      lib: ({ store }) => corpusStats(store),
    });
    strictEqual(result.cli.code, 0, result.cli.err);
    ok(result.lib.ok);
    deepStrictEqual(JSON.parse(result.cli.out), { corpus: cliCorpus, ...(result.lib.value as object) });
  });

  it("ka sources list prints sourceStatus over the registry", async () => {
    const result = await parity({
      seed: seedSummary,
      argv: (corpus) => ["--compact", "--corpus", corpus, "sources", "list", "--json"],
      lib: ({ store }) => sourceStatus(store, SOURCE_REGISTRY),
    });
    strictEqual(result.cli.code, 0, result.cli.err);
    ok(result.lib.ok);
    deepStrictEqual(JSON.parse(result.cli.out), JSON.parse(JSON.stringify(result.lib.value)));
  });
});

describe("search filter rules (finding 2)", () => {
  /** Four records over three parliaments and two dates, with vectors for --like. */
  function seedFilters(corpus: string): void {
    const store = new FileStore(corpus);
    const make = (id: string, period: number, submitted: string, party: string) =>
      sampleRecord({
        id,
        parliament: id.split("-")[0] as ReturnType<typeof sampleRecord>["parliament"],
        reference: `${period}/${id.split("-")[2] as string}`,
        legislative_period: period,
        dates: { submitted },
        askers: [{ name: "Erika Mustermann", party, role: "MdL" }],
      });
    const records = [
      make("berlin-19-1", 19, "2024-01-15", "SPD"),
      make("berlin-19-2", 19, "2024-03-01", "CDU"),
      make("bayern-18-3", 18, "2024-05-01", "SPD"),
      make("sachsen-7-4", 7, "2023-11-11", "SPD"),
    ];
    for (const record of records) {
      store.putRecord(record);
      indexRecord(store, record);
    }
    store.flushCatalog();
    store.saveEmbeddings({
      model: "test",
      dimensions: 2,
      vectors: { "berlin-19-1": [1, 0], "berlin-19-2": [0.9, 0.1], "bayern-18-3": [0.8, 0.2], "sachsen-7-4": [0.1, 0.9] },
    });
  }
  const ids = (value: unknown): string[] => (value as { hits: { entry: { id: string } }[] }).hits.map((hit) => hit.entry.id);

  const agreeing: [string[], SearchFilters][] = [
    [["--parliament", "Berlin"], { parliament: ["Berlin"] }],
    [["--parliament", "BERLIN"], { parliament: ["BERLIN"] }],
    [["--from", " 2024-03-01"], { from: " 2024-03-01" }],
    [["--to", " 2024-03-01"], { to: " 2024-03-01" }],
    [["--party", " cdu "], { party: [" cdu "] }],
  ];
  for (const [flags, filters] of agreeing) {
    it(`search ${flags.join(" ")} matches search() with ${JSON.stringify(filters)}`, async () => {
      const result = await parity({
        seed: seedFilters,
        argv: (corpus) => ["--compact", "--corpus", corpus, "search", "--json", ...flags],
        lib: ({ store }) => search(store, "", filters),
      });
      strictEqual(result.cli.code, 0, result.cli.err);
      ok(result.lib.ok, JSON.stringify(result.lib));
      deepStrictEqual(ids(JSON.parse(result.cli.out)), ids(result.lib.value));
      ok(ids(result.lib.value).length > 0);
    });
  }

  it("search --like and export apply the same normalised parliament", async () => {
    const like = await parity({
      seed: seedFilters,
      argv: (corpus) => ["--compact", "--corpus", corpus, "search", "--json", "--like", "berlin-19-1", "--parliament", "Berlin"],
      lib: ({ store }) => searchLike(store, "berlin-19-1", { parliament: ["Berlin"] }),
    });
    strictEqual(like.cli.code, 0, like.cli.err);
    deepStrictEqual(ids(JSON.parse(like.cli.out)), ["berlin-19-2"]);
    ok(like.lib.ok);
    deepStrictEqual(ids(like.lib.value), ["berlin-19-2"]);

    const exported = await parity({
      seed: seedFilters,
      argv: (corpus) => ["--corpus", corpus, "export", "--format", "csv", "--parliament", "Berlin"],
      lib: ({ store }) => selectRecords(store, "", { parliament: ["Berlin"] }).records.map((record) => record.id),
    });
    strictEqual(exported.cli.code, 0, exported.cli.err);
    deepStrictEqual(exported.lib, { ok: true, value: ["berlin-19-1", "berlin-19-2"], requests: [] });
  });

  const refused: [string[], SearchFilters, string, string][] = [
    [["--parliament", "narnia"], { parliament: ["narnia"] }, "parliament", `Unknown parliament "narnia". Known: `],
    [["--from", "2024-02-30"], { from: "2024-02-30" }, "from", "Not a calendar date."],
    [["--to", "2024-1-5"], { to: "2024-1-5" }, "to", "Expected a date as YYYY-MM-DD."],
    [["--from", "2024"], { from: "2024" }, "from", "Expected a date as YYYY-MM-DD."],
    [["--party", ""], { party: [""] }, "party", "Expected a non-empty value."],
    [["--review-status", "verified"], { reviewStatus: ["verified"] }, "reviewStatus", "Allowed choices are ok, needs_review, human_verified."],
    [["--year", "24"], { year: [24] }, "year", "Must be >= 1949."],
    [["--period", "0"], { period: [0] }, "period", "Must be >= 1."],
  ];
  for (const [flags, filters, name, reason] of refused) {
    it(`refuses ${flags.join(" ")} on both sides`, async () => {
      const result = await parity({
        seed: seedFilters,
        argv: (corpus) => ["--compact", "--corpus", corpus, "search", "--json", ...flags],
        lib: ({ store }) => search(store, "", filters),
      });
      strictEqual(result.cli.code, EXIT_USAGE, result.cli.err);
      ok(result.cli.err.includes(reason), result.cli.err);
      ok(!result.lib.ok, JSON.stringify(result.lib));
      strictEqual(result.lib.error.name, "OpenKaValidationError");
      ok(result.lib.error.message.startsWith(`Invalid ${name}: ${reason}`), result.lib.error.message);
    });
  }
});

describe("lib-render's formats and feed options (finding 18)", () => {
  function seedRecord(corpus: string): void {
    const store = new FileStore(corpus);
    store.putRecord(sampleRecord());
    indexRecord(store, sampleRecord());
    store.flushCatalog();
  }
  const updated = "2026-01-02T03:04:05Z";

  for (const format of ["xml", "JSON", "", " json"]) {
    it(`refuses get --format ${JSON.stringify(format)} on both sides`, async () => {
      const result = await parity({
        seed: seedRecord,
        argv: (corpus) => ["--corpus", corpus, "get", "berlin-19-12345", "--format", format],
        lib: ({ store }) => renderRecord(store.getRecord("berlin-19-12345") as never, format as never),
      });
      bothRefused(result, "format", "Allowed choices are json, jsonld, csv, md, text.");
    });
  }

  for (const [flag, name] of [["--title", "title"], ["--id", "id"]] as const) {
    for (const blank of ["", "  "]) {
      it(`refuses feed ${flag} ${JSON.stringify(blank)} on both sides`, async () => {
        const result = await parity({
          seed: seedRecord,
          argv: (corpus) => ["--corpus", corpus, "feed", flag, blank],
          lib: ({ store }) => renderAtom(selectRecords(store, "").records, { updated, [name]: blank }),
        });
        bothRefused(result, name, BLANK);
      });
    }
  }

  it("builds the same default feed: the defaults are the library's", async () => {
    const result = await parity({
      seed: seedRecord,
      argv: (corpus) => ["--corpus", corpus, "feed"],
      lib: ({ store }) => renderAtom(selectRecords(store, "").records, { updated }),
    });
    strictEqual(result.cli.code, 0, result.cli.err);
    ok(result.lib.ok);
    strictEqual(result.cli.out + "\n", result.lib.value);
  });
});

describe("where goldens add files a golden without --dir (finding 3)", () => {
  it("files it where list and verify read, the same place addGolden does", async () => {
    // A throwaway workspace as the cwd: without --dir the golden goes into the
    // workspace around the cwd, and that must never be this repository.
    const ws = realpathSync(mkdtempSync(join(tmpdir(), "openka-ws-")));
    writeFileSync(join(ws, "package.json"), "{}\n");
    mkdirSync(join(ws, "packages", "connector-berlin"), { recursive: true });
    const cwd = process.cwd();
    process.chdir(ws);
    try {
      let afterCli: string[] = [];
      const expected = join(ws, "packages", "connector-berlin", "fixtures", "berlin", "berlin-19-12345");
      const result = await parity({
        runner: runFactory,
        seed: seedOneRecord,
        argv: (corpus) => ["--corpus", corpus, "goldens", "add", "berlin-19-12345"],
        lib: ({ store }) => {
          afterCli = listAllGoldens(ws).map((golden) => golden.dir);
          return addGolden(store, "berlin-19-12345").dir;
        },
      });
      strictEqual(result.cli.code, 0, result.cli.err);
      strictEqual(result.cli.out, `Froze berlin-19-12345 as a golden in ${expected}`);
      deepStrictEqual(afterCli, [expected]);
      deepStrictEqual(result.lib, { ok: true, value: expected, requests: [] });
      deepStrictEqual(readdirSync(ws).sort(), ["package.json", "packages"]);
    } finally {
      process.chdir(cwd);
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe("the default drift-baseline location (finding 26)", () => {
  const NOW = "2026-01-02T03:04:05Z";

  it("health --save-baseline writes where saveCorpusBaseline writes, and the library reads it back", async () => {
    let cliCorpus = "";
    let cliBytes = "";
    let cliReadBack: unknown;
    const result = await parity({
      runner: runFactory,
      seed: seedOneRecord,
      argv: (corpus) => {
        cliCorpus = corpus;
        return ["--corpus", corpus, "health", "--save-baseline"];
      },
      lib: ({ store, corpus }) => {
        cliBytes = readFileSync(baselinePath(cliCorpus), "utf8");
        cliReadBack = loadCorpusBaseline(cliCorpus);
        const path = saveCorpusBaseline(corpus, measureHealth(store, NOW));
        return { relative: path.slice(corpus.length), bytes: readFileSync(path, "utf8") };
      },
    });
    strictEqual(result.cli.code, 0, result.cli.err);
    strictEqual(result.cli.err, `Baseline written to ${join(cliCorpus, BASELINE_FILE)}.`);
    deepStrictEqual(result.lib, { ok: true, value: { relative: `/${BASELINE_FILE}`, bytes: cliBytes }, requests: [] });
    strictEqual((cliReadBack as { taken_at: string }).taken_at, NOW);
  });

  it("drift without --baseline reads the corpus's default baseline, like loadCorpusBaseline", async () => {
    const result = await parity({
      runner: runFactory,
      seed: (corpus) => {
        seedOneRecord(corpus);
        saveBaseline(join(corpus, BASELINE_FILE), measureHealth(new FileStore(corpus), "2025-12-01T00:00:00Z"));
      },
      argv: (corpus) => ["--compact", "--corpus", corpus, "drift", "--json"],
      lib: ({ store, corpus }) => {
        const baseline = loadCorpusBaseline(corpus);
        return { baseline: baseline?.taken_at ?? null, findings: detectDrift(measureHealth(store, NOW), baseline) };
      },
    });
    strictEqual(result.cli.code, 0, result.cli.err);
    deepStrictEqual(result.lib, { ok: true, value: JSON.parse(result.cli.out), requests: [] });
    strictEqual((result.lib as { value: { baseline: string } }).value.baseline, "2025-12-01T00:00:00Z");
  });

  it("refuses a corpus root or baseline path that is not a string", () => {
    for (const call of [
      () => baselinePath(undefined as unknown as string),
      () => loadBaseline(undefined as unknown as string),
      () => saveBaseline(42 as unknown as string, { taken_at: NOW, records: 0, sources: [] }),
    ]) {
      throws(call, (error: unknown) => error instanceof OpenKaValidationError && /: Expected a path\.$/.test(error.message));
    }
  });
});

describe("search paging bounds (finding 4)", () => {
  const cases: { argv: string[]; name: string; reason: string; lib: (store: FileStore) => unknown }[] = [
    { argv: ["search", "--json", "--limit", "0"], name: "limit", reason: "Must be >= 1.", lib: (store) => search(store, "", { limit: 0 }) },
    { argv: ["search", "--json", "--limit", "-1"], name: "limit", reason: "Must be >= 1.", lib: (store) => search(store, "", { limit: -1 }) },
    { argv: ["search", "--json", "--limit", "1.5"], name: "limit", reason: "Expected an integer.", lib: (store) => search(store, "", { limit: 1.5 }) },
    { argv: ["search", "--json", "--offset", "-1"], name: "offset", reason: "Must be >= 0.", lib: (store) => search(store, "", { offset: -1 }) },
    {
      argv: ["search", "--json", "--like", "berlin-19-12345", "--limit", "-1"],
      name: "limit",
      reason: "Must be >= 1.",
      lib: (store) => searchLike(store, "berlin-19-12345", { limit: -1 }),
    },
    { argv: ["export", "--format", "jsonl", "--limit", "-1"], name: "limit", reason: "Must be >= 1.", lib: (store) => selectRecords(store, "", { limit: -1 }) },
    { argv: ["review", "--limit", "0"], name: "limit", reason: "Must be >= 1.", lib: (store) => reviewQueue(store, { limit: 0 }) },
  ];

  for (const { argv, name, reason, lib } of cases) {
    it(`refuses ${argv.join(" ")} on both sides`, async () => {
      const result = await parity({
        seed: seedOneRecord,
        argv: (corpus) => ["--corpus", corpus, ...argv],
        lib: ({ store }) => lib(store),
      });
      bothRefused(result, name, reason);
    });
  }

  it("pages the same way at the bounds", async () => {
    const result = await parity({
      seed: seedOneRecord,
      argv: (corpus) => ["--compact", "--corpus", corpus, "search", "--json", "--limit", "1", "--offset", "0"],
      lib: ({ store }) => search(store, "", { limit: 1, offset: 0 }),
    });
    strictEqual(result.cli.code, 0, result.cli.err);
    deepStrictEqual(JSON.parse(result.cli.out), JSON.parse(JSON.stringify((result.lib as { value: unknown }).value)));
  });
});

describe("the embedding dimensions (finding 21)", () => {
  for (const [value, reason] of [
    ["0", "Must be >= 16."],
    ["15", "Must be >= 16."],
    ["-1", "Must be >= 16."],
    ["4097", "Must be <= 4096."],
    ["1.5", "Expected an integer."],
  ] as const) {
    it(`refuses ${value} dimensions on both sides, saving nothing`, async () => {
      let cliCorpus = "";
      const result = await parity({
        runner: runFactory,
        seed: seedOneRecord,
        argv: (corpus) => {
          cliCorpus = corpus;
          return ["--corpus", corpus, "embed", `--dimensions=${value}`];
        },
        lib: ({ store }) => {
          ok(new FileStore(cliCorpus).loadEmbeddings() === undefined, "the CLI saved no embeddings");
          return buildEmbeddings(store, Number(value));
        },
      });
      bothRefused(result, "dimensions", reason);
    });
  }

  it("builds the same set at the default and at the bounds", async () => {
    for (const argv of [[], ["--dimensions", String(MIN_DIMENSIONS)], ["--dimensions", String(MAX_DIMENSIONS)]]) {
      let cliCorpus = "";
      const result = await parity({
        runner: runFactory,
        seed: seedOneRecord,
        argv: (corpus) => {
          cliCorpus = corpus;
          return ["--corpus", corpus, "embed", ...argv];
        },
        lib: ({ store }) => {
          const set = buildEmbeddings(store, argv[1] === undefined ? undefined : Number(argv[1]));
          deepStrictEqual(new FileStore(cliCorpus).loadEmbeddings(), set);
          return set.dimensions;
        },
      });
      strictEqual(result.cli.code, 0, result.cli.err);
      deepStrictEqual(result.lib, { ok: true, value: argv[1] === undefined ? DEFAULT_DIMENSIONS : Number(argv[1]), requests: [] });
    }
  });
});

describe("the answer sweep's range (finding 20)", () => {
  const NOW = "2026-01-02T03:04:05Z";
  const cases: { period: string; from: string; to: string; name: string; reason: string }[] = [
    { period: "19", from: "5", to: "1", name: "to", reason: "Must be >= from (5)." },
    { period: "0", from: "8100", to: "8100", name: "period", reason: "Must be >= 1." },
    { period: "100", from: "8100", to: "8100", name: "period", reason: "Must be <= 99." },
    { period: "19", from: "0", to: "8100", name: "from", reason: "Must be >= 1." },
    { period: "19", from: "1.5", to: "8100", name: "from", reason: "Expected an integer." },
    { period: "19", from: "1", to: "1000000", name: "to", reason: "Must be <= 999999." },
  ];
  for (const { period, from, to, name, reason } of cases) {
    it(`refuses period ${period}, ${from}..${to} on both sides, before any request or write`, async () => {
      const result = await parity({
        runner: runFactory,
        argv: (corpus) => ["--corpus", corpus, "answers", "niedersachsen", "--json", "--period", period, "--from", from, "--to", to],
        lib: async ({ engine, store }) => {
          try {
            return await sweepAnswers({ engine, store, period: Number(period), from: Number(from), to: Number(to), now: NOW });
          } finally {
            strictEqual(store.loadArtifact("niedersachsen-answers"), undefined, "nothing was written");
          }
        },
      });
      bothRefused(result, name, reason);
    });
  }
});

describe("a query with nothing searchable (finding 1)", () => {
  const reason = (query: string): string =>
    `Nothing searchable in ${JSON.stringify(query)} — terms are runs of letters and digits ` +
    "of at least two characters, so this would have matched every record.";

  for (const query of ["???", "---", "?x", "a", "-"]) {
    it(`refuses ${JSON.stringify(query)} in search, export and feed, as search() does`, async () => {
      for (const [argv, lib] of [
        [["search", "--json", "--", query], (store: FileStore) => search(store, query)],
        [["export", "--format", "jsonl", "--query", query], (store: FileStore) => selectRecords(store, query)],
        [["feed", "--query", query], (store: FileStore) => selectRecords(store, query)],
      ] as const) {
        const result = await parity({ seed: seedOneRecord, argv: (corpus) => ["--corpus", corpus, ...argv], lib: ({ store }) => lib(store) });
        bothRefused(result, "query", reason(query));
      }
    });
  }

  it("still answers an empty query and an exclusion-only query", async () => {
    for (const query of ["", "-radwege", "Brücken"]) {
      const result = await parity({
        seed: seedOneRecord,
        argv: (corpus) => ["--compact", "--corpus", corpus, "search", "--json", "--", query],
        lib: ({ store }) => search(store, query),
      });
      strictEqual(result.cli.code, 0, result.cli.err);
      deepStrictEqual(JSON.parse(result.cli.out), JSON.parse(JSON.stringify((result.lib as { value: unknown }).value)));
    }
  });
});

describe("a corpus that is not there (finding 7)", () => {
  const HINT = " Check --corpus / OPENKA_CORPUS, or run `ka sync` first.";

  for (const argv of [["search", "--json"], ["stats", "--json"], ["get", "berlin-19-12345"], ["export", "--format", "jsonl"]]) {
    it(`refuses ${argv[0]} on a missing directory, as FileStore.open does`, async () => {
      let cliRoot = "";
      const result = await parity({
        argv: (corpus) => {
          cliRoot = join(corpus, "typo");
          return ["--corpus", cliRoot, ...argv];
        },
        lib: ({ corpus }) => search(FileStore.open(join(corpus, "typo")), ""),
      });
      strictEqual(result.cli.code, EXIT_STORE, result.cli.err);
      strictEqual(result.cli.err, `Error: No corpus at ${cliRoot}: nothing has been synced there.${HINT}`);
      deepStrictEqual(result.cli.requests, []);
      ok(!result.lib.ok);
      strictEqual(result.lib.error.name, "MissingCorpusError");
      ok(result.lib.error.message.endsWith("typo: nothing has been synced there."), result.lib.error.message);
      ok(!existsSync(cliRoot), "a read command must not create the corpus");
    });
  }

  it("refuses a path that is a file, not a directory, on both sides", async () => {
    let cliRoot = "";
    const result = await parity({
      seed: (corpus) => writeFileSync(join(corpus, "afile"), "x"),
      argv: (corpus) => {
        cliRoot = join(corpus, "afile");
        return ["--corpus", cliRoot, "stats", "--json"];
      },
      lib: ({ corpus }) => corpusStats(FileStore.open(join(corpus, "afile"))),
    });
    strictEqual(result.cli.code, EXIT_STORE, result.cli.err);
    strictEqual(result.cli.err, `Error: ${cliRoot} is not a directory, so it cannot be a corpus.`);
    ok(!result.lib.ok);
    strictEqual(result.lib.error.name, "StoreError");
    ok(result.lib.error.message.endsWith("afile is not a directory, so it cannot be a corpus."), result.lib.error.message);
  });

  it("opens an existing corpus the same way new FileStore does", async () => {
    const result = await parity({
      seed: seedOneRecord,
      argv: (corpus) => ["--compact", "--corpus", corpus, "search", "--json"],
      lib: ({ corpus }) => search(FileStore.open(corpus), ""),
    });
    strictEqual(result.cli.code, 0, result.cli.err);
    deepStrictEqual(JSON.parse(result.cli.out), JSON.parse(JSON.stringify((result.lib as { value: unknown }).value)));
  });
});

describe("a named drift baseline that is not there (finding 22)", () => {
  it("is an error on both sides, not a first run", async () => {
    let cliPath = "";
    const result = await parity({
      runner: runFactory,
      seed: seedOneRecord,
      argv: (corpus) => {
        cliPath = join(corpus, "helth-baseline.json");
        return ["--corpus", corpus, "drift", "--baseline", cliPath, "--json"];
      },
      lib: ({ corpus }) => loadBaseline(join(corpus, "helth-baseline.json")),
    });
    const message = (path: string): string => `No baseline at ${path}. Write one with \`ka-factory health --save-baseline\`.`;
    strictEqual(result.cli.code, 1, result.cli.err);
    strictEqual(result.cli.err, `Error: ${message(cliPath)}`);
    ok(!result.lib.ok);
    strictEqual(result.lib.error.name, "OpenKaError");
    ok(result.lib.error.message.endsWith("/helth-baseline.json. Write one with `ka-factory health --save-baseline`."), result.lib.error.message);
  });

  it("leaves a missing default baseline a first run, on both sides", async () => {
    const result = await parity({
      runner: runFactory,
      seed: seedOneRecord,
      argv: (corpus) => ["--compact", "--corpus", corpus, "drift", "--json"],
      lib: ({ store, corpus }) => {
        const baseline = loadCorpusBaseline(corpus);
        return { baseline: baseline?.taken_at ?? null, findings: detectDrift(measureHealth(store, "2026-01-02T03:04:05Z"), baseline) };
      },
    });
    strictEqual(result.cli.code, 0, result.cli.err);
    deepStrictEqual(result.lib, { ok: true, value: JSON.parse(result.cli.out), requests: [] });
    strictEqual((result.lib as { value: { baseline: unknown } }).value.baseline, null);
  });
});

describe("a lint that would scan nothing (finding 23)", () => {
  const nothing = (root: string): string => `nothing to lint: no packages/*/src under ${root} — is this the workspace root?`;

  for (const [label, dir] of [
    ["an empty directory", (corpus: string) => corpus],
    ["a missing directory", (corpus: string) => join(corpus, "missing")],
    ["a packages/ with no sources", (corpus: string) => join(corpus, "ws")],
  ] as const) {
    it(`fails on ${label} on both sides, rather than passing`, async () => {
      let cliRoot = "";
      let libRoot = "";
      const seed = (corpus: string): void => {
        mkdirSync(join(corpus, "ws", "packages", "lib-x"), { recursive: true });
      };
      const result = await parity({
        runner: runFactory,
        seed,
        argv: (corpus) => {
          cliRoot = dir(corpus);
          return ["lint", "--json", "--root", cliRoot];
        },
        lib: ({ corpus }) => {
          libRoot = dir(corpus);
          return lintLine(libRoot);
        },
      });
      strictEqual(result.cli.code, 1, result.cli.err);
      strictEqual(result.cli.err, `Error: ${nothing(cliRoot)}`);
      ok(!result.lib.ok);
      deepStrictEqual(result.lib.error, { name: "OpenKaError", message: nothing(libRoot) });
    });
  }

  it("refuses a blank root on both sides", async () => {
    for (const blank of ["", "  "]) {
      const result = await parity({ runner: runFactory, argv: ["lint", "--root", blank], lib: () => lintLine(blank) });
      bothRefused(result, "root", BLANK);
    }
  });
});

describe("the goldens gate (finding 25)", () => {
  /** Copies of real Berlin goldens under `<corpus>/goldens`; `tamper` edits the first one's frozen answer. */
  const seedGoldens = (tamper: boolean) => (corpus: string): void => {
    const real = listAllGoldens().filter((golden) => golden.meta.source === "berlin" && golden.meta.tier !== "ocr" && golden.record.qa.length > 0);
    ok(real.length >= 2, "expected two Berlin goldens with Q/A in the workspace");
    for (const [index, golden] of real.slice(0, 2).entries()) {
      const target = join(corpus, "goldens", "berlin", golden.meta.id);
      cpSync(golden.dir, target, { recursive: true });
      if (tamper && index === 0) {
        const qa = golden.record.qa.map((pair, at) => (at === 0 ? { ...pair, answer: "erfunden" } : pair));
        writeFileSync(join(target, "record.json"), canonicalJsonLine({ ...golden.record, qa }));
      }
    }
  };

  it("refuses an empty set on both sides, rather than passing it", async () => {
    for (const [label, dir] of [
      ["an empty directory", (corpus: string) => corpus],
      ["a missing directory", (corpus: string) => join(corpus, "missing")],
    ] as const) {
      let cliDir = "";
      let libDir = "";
      const result = await parity({
        runner: runFactory,
        argv: (corpus) => {
          cliDir = dir(corpus);
          return ["goldens", "verify", "--dir", cliDir, "--json"];
        },
        lib: async ({ corpus }) => {
          libDir = dir(corpus);
          return verifyGoldens({ dir: libDir });
        },
      });
      const nothing = (path: string): string => `No goldens in ${path} — nothing to verify.`;
      strictEqual(result.cli.code, 1, `${label}: ${result.cli.err}`);
      strictEqual(result.cli.err, `Error: ${nothing(cliDir)}`);
      deepStrictEqual(result.lib, { ok: false, error: { name: "OpenKaError", message: nothing(libDir) }, requests: [] });
    }
  });

  it("refuses a blank directory on both sides", async () => {
    for (const blank of ["", "  "]) {
      bothRefused(await parity({ runner: runFactory, argv: ["goldens", "verify", "--dir", blank], lib: () => verifyGoldens({ dir: blank }) }), "dir", BLANK);
      bothRefused(await parity({ runner: runFactory, argv: ["goldens", "list", "--dir", blank], lib: () => listGoldens(blank) }), "root", BLANK);
    }
  });

  it("reports the same tally as the CLI, and passes the gate when every golden reproduces", async () => {
    const result = await parity({
      runner: runFactory,
      seed: seedGoldens(false),
      argv: (corpus) => ["--compact", "goldens", "verify", "--dir", join(corpus, "goldens"), "--json"],
      lib: async ({ corpus }) => {
        const report = await verifyGoldens({ dir: join(corpus, "goldens") });
        assertGoldensPass(report);
        return report;
      },
    });
    strictEqual(result.cli.code, 0, result.cli.err);
    deepStrictEqual(result.lib, { ok: true, value: JSON.parse(result.cli.out), requests: [] });
    strictEqual((result.lib as { value: { checked: number; passed: number } }).value.passed, 2);
  });

  it("fails the gate on both sides when one golden regressed", async () => {
    const regressed = "1 golden(s) regressed — an extractor may not be promoted while a golden is red";
    let libReport: unknown;
    const result = await parity({
      runner: runFactory,
      seed: seedGoldens(true),
      argv: (corpus) => ["--compact", "goldens", "verify", "--dir", join(corpus, "goldens"), "--json"],
      lib: async ({ corpus }) => {
        libReport = await verifyGoldens({ dir: join(corpus, "goldens") });
        assertGoldensPass(libReport as Awaited<ReturnType<typeof verifyGoldens>>);
      },
    });
    strictEqual(result.cli.code, 1, result.cli.err);
    strictEqual(result.cli.err, `Error: ${regressed}`);
    deepStrictEqual(JSON.parse(JSON.stringify(libReport)), JSON.parse(result.cli.out));
    deepStrictEqual(result.lib, { ok: false, error: { name: "OpenKaError", message: regressed }, requests: [] });
  });
});

describe("the sync window and budget (finding 5)", () => {
  const syncLib = (window: Record<string, unknown>) => ({ store, engine }: { store: FileStore; engine: FetchEngine }) =>
    sync({ source: createSource("berlin"), store, engine, metadataOnly: true, ...window });

  for (const [flag, value, option, libValue, reason] of [
    ["--since", "", "since", "", "Expected a date as YYYY-MM-DD."],
    ["--until", "  ", "until", "  ", "Expected a date as YYYY-MM-DD."],
    ["--since", "2026-02-30", "since", "2026-02-30", "Not a calendar date."],
    ["--since", "2021-9-1", "since", "2021-9-1", "Expected a date as YYYY-MM-DD."],
    ["--period", "0", "period", 0, "Must be >= 1."],
    ["--period", "100", "period", 100, "Must be <= 99."],
    ["--period", "1.5", "period", 1.5, "Expected an integer."],
    ["--limit", "0", "limit", 0, "Must be >= 1."],
    ["--limit", "-1", "limit", -1, "Must be >= 1."],
  ] as const) {
    it(`refuses ${flag} ${JSON.stringify(value)} on both sides, before any request`, async () => {
      const result = await parity({
        argv: (corpus) => ["--corpus", corpus, "sync", "--source", "berlin", "--metadata-only", flag, value],
        lib: syncLib({ [option]: libValue }),
      });
      bothRefused(result, option, reason);
    });
  }

  it("refuses a window that ends before it starts, on both sides", async () => {
    const result = await parity({
      argv: (corpus) => ["--corpus", corpus, "sync", "--source", "berlin", "--metadata-only", "--since", "2024-06-01", "--until", "2024-01-01"],
      lib: syncLib({ since: "2024-06-01", until: "2024-01-01" }),
    });
    bothRefused(result, "until", "Must be >= since (2024-06-01).");
  });

  it("refuses a source named twice, on both sides, before any request", async () => {
    const result = await parity({
      argv: (corpus) => ["--corpus", corpus, "sync", "--source", "berlin", "--source", "berlin", "--metadata-only"],
      lib: ({ store, engine }) =>
        syncSources({ sources: [createSource("berlin"), createSource("berlin")], store, engineFor: () => engine, metadataOnly: true }),
    });
    bothRefused(result, "sources", '"berlin" is named twice.');
  });

  it("refuses a bad window for several sources once, on both sides, before any request", async () => {
    const result = await parity({
      argv: (corpus) => ["--corpus", corpus, "sync", "--source", "berlin", "--source", "saarland", "--since", "2024-06-01", "--until", "2024-01-01"],
      lib: ({ store, engine }) =>
        syncSources({ sources: [createSource("berlin"), createSource("saarland")], store, engineFor: () => engine, since: "2024-06-01", until: "2024-01-01" }),
    });
    bothRefused(result, "until", "Must be >= since (2024-06-01).");
  });

  it("trims a padded date on both sides, so DIP gets the same request", async () => {
    const result = await parity({
      env: { DIP_API_KEY: "test-key" },
      responder: async () => ({ status: 200, headers: { "content-type": "application/json" }, body: Buffer.from('{"documents":[]}') }),
      argv: (corpus) => ["--corpus", corpus, "sync", "--source", "bund", "--metadata-only", "--since", " 2026-08-01", "--until", "2026-08-31 "],
      lib: ({ store, engine }) =>
        sync({ source: createSource("bund"), store, engine, apiKey: "test-key", metadataOnly: true, since: " 2026-08-01", until: "2026-08-31 " }),
    });
    strictEqual(result.cli.code, 0, result.cli.err);
    ok(result.lib.ok, JSON.stringify(result.lib));
    deepStrictEqual(result.lib.requests, result.cli.requests);
    ok(result.cli.requests.length > 0);
    ok(result.cli.requests.every((request) => /f\.datum\.start=2026-08-01&/.test(request) && !/=%20|%20&/.test(request)), result.cli.requests.join("\n"));
  });
});

describe("the fetch engine's options (finding 6)", () => {
  for (const [flag, value, option, libValue, reason] of [
    ["--max-retries", "25", "maxRetries", 25, "Must be <= 10."],
    ["--max-retries", "-1", "maxRetries", -1, "Must be >= 0."],
    ["--max-retries", "1.5", "maxRetries", 1.5, "Expected an integer."],
    ["--max-redirects", "11", "maxRedirects", 11, "Must be <= 10."],
    ["--max-redirects", "-1", "maxRedirects", -1, "Must be >= 0."],
    ["--max-response-bytes", "10", "maxResponseBytes", 10, "Must be >= 1024."],
    ["--min-host-interval", "60001", "minHostIntervalMs", 60_001, "Must be <= 60000."],
    ["--min-host-interval", "-5", "minHostIntervalMs", -5, "Must be >= 0."],
    ["--timeout", "-1", "timeoutMs", -1, "Must be >= 0."],
    ["--user-agent", "", "userAgent", "", "Expected a non-empty value."],
    ["--user-agent", "  ", "userAgent", "  ", "Expected a non-empty value."],
    ["--user-agent", "ka\r\nX-Injected: 1", "userAgent", "ka\r\nX-Injected: 1", "Expected a header value: no control characters, nothing above U+00FF."],
    ["--user-agent", "ka €", "userAgent", "ka €", "Expected a header value: no control characters, nothing above U+00FF."],
  ] as const) {
    it(`refuses ${flag} ${JSON.stringify(value)} on both sides, before any request`, async () => {
      const result = await parity({
        argv: (corpus) => ["--corpus", corpus, flag, value, "sync", "--source", "berlin", "--metadata-only"],
        lib: ({ transport }) => new FetchEngine({ transport, [option]: libValue }),
      });
      bothRefused(result, option, reason);
    });
  }

  it("takes the bounds themselves on both sides", async () => {
    const responder = async (): Promise<never> => {
      throw new Error("offline");
    };
    const result = await parity({
      responder,
      argv: (corpus) => ["--corpus", corpus, "--max-retries", "10", "--max-redirects", "10", "--max-response-bytes", "1024", "--user-agent", "ka-test/1.0 (é)", "sources", "list", "--json"],
      lib: ({ transport }) => new FetchEngine({ transport, maxRetries: MAX_RETRIES, maxRedirects: MAX_REDIRECTS, maxResponseBytes: MIN_RESPONSE_BYTES, minHostIntervalMs: MAX_HOST_INTERVAL_MS, userAgent: "ka-test/1.0 (é)" }).userAgent,
    });
    strictEqual(result.cli.code, 0, result.cli.err);
    deepStrictEqual(result.lib, { ok: true, value: "ka-test/1.0 (é)", requests: [] });
  });
});

describe("where the corpus is (finding 19)", () => {
  /** A directory outside both sides' corpora, holding a seeded corpus at `name`. */
  const shared = (name: string): { base: string; dir: string; done: () => void } => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "openka-root-")));
    const dir = join(base, name);
    seedOneRecord(dir);
    return { base, dir, done: () => rmSync(base, { recursive: true, force: true }) };
  };

  it("takes OPENKA_CORPUS as given, like --corpus: a trailing space is part of the name", async () => {
    const { dir, done } = shared("spaced ");
    try {
      for (const argv of [["--compact", "stats", "--json"], ["--compact", "--corpus", dir, "stats", "--json"]]) {
        const result = await parity({
          env: { OPENKA_CORPUS: dir },
          argv,
          lib: () => {
            const root = resolveCorpusRoot({ env: { OPENKA_CORPUS: dir } });
            return { corpus: root, ...corpusStats(FileStore.open(root)) };
          },
        });
        strictEqual(result.cli.code, 0, result.cli.err);
        deepStrictEqual(result.lib, { ok: true, value: JSON.parse(result.cli.out), requests: [] });
        strictEqual((result.lib as { value: { corpus: string; records: number } }).value.corpus, dir);
        strictEqual((result.lib as { value: { records: number } }).value.records, 1);
      }
    } finally {
      done();
    }
  });

  it("takes a leading space as given too, so the env var and the flag name one directory", async () => {
    const { dir, done } = shared("corpus");
    try {
      const padded = ` ${dir}`;
      const expected = resolve(padded);
      for (const [argv, env] of [
        [["stats", "--json"], { OPENKA_CORPUS: padded }],
        [["--corpus", padded, "stats", "--json"], {}],
      ] as const) {
        const result = await parity({ env, argv: [...argv], lib: () => resolveCorpusRoot({ root: padded, env: {} }) });
        strictEqual(result.cli.code, EXIT_STORE, result.cli.err);
        ok(result.cli.err.startsWith(`Error: No corpus at ${expected}`), result.cli.err);
        deepStrictEqual(result.lib, { ok: true, value: expected, requests: [] });
      }
    } finally {
      done();
    }
  });

  it("reads a blank OPENKA_CORPUS as unset on both sides, and refuses a blank root", async () => {
    const { base, done } = shared("openka");
    try {
      const env = { OPENKA_CORPUS: "  ", XDG_DATA_HOME: base };
      const result = await parity({
        env,
        argv: ["--compact", "stats", "--json"],
        lib: () => resolveCorpusRoot({ env }),
      });
      strictEqual(result.cli.code, 0, result.cli.err);
      strictEqual(JSON.parse(result.cli.out).corpus, join(base, "openka"));
      deepStrictEqual(result.lib, { ok: true, value: join(base, "openka"), requests: [] });
      for (const blank of ["", "  "]) {
        bothRefused(await parity({ argv: ["--corpus", blank, "stats"], lib: () => resolveCorpusRoot({ root: blank, env: {} }) }), "root", BLANK);
      }
    } finally {
      done();
    }
  });

  it("falls back to XDG_DATA_HOME, then the home directory", () => {
    strictEqual(resolveCorpusRoot({ env: { XDG_DATA_HOME: "/tmp/share" } }), resolve("/tmp/share", "openka"));
    strictEqual(resolveCorpusRoot({ env: {} }), resolve(homedir(), ".local", "share", "openka"));
    strictEqual(CORPUS_ENV, "OPENKA_CORPUS");
  });
});

describe("OCR engine setup (finding 10)", () => {
  /** What every door says when the engine for `mode` cannot run here. */
  const commands = (mode: string): { name: string; runner?: typeof runFactory; argv: (corpus: string) => string[] }[] => [
    { name: "ka sync", argv: (corpus) => ["--corpus", corpus, "sync", "--source", "berlin", "--ocr", mode] },
    { name: "ka verify", argv: (corpus) => ["--corpus", corpus, "verify", "berlin-19-12345", "--ocr", mode] },
    { name: "ka-factory goldens verify", runner: runFactory, argv: (corpus) => ["goldens", "verify", "--dir", corpus, "--ocr", mode] },
  ];

  const sameRefusal = async (mode: "tesseract" | "tesseract-js"): Promise<void> => {
    for (const command of commands(mode)) {
      const result = await parity({
        ...(command.runner === undefined ? {} : { runner: command.runner }),
        seed: seedOneRecord,
        argv: command.argv,
        lib: () => createPerceiver(mode),
      });
      ok(!result.lib.ok, `${command.name}: the library built a perceiver`);
      strictEqual(result.lib.error.name, "OpenKaError");
      strictEqual(result.cli.code, 1, `${command.name}: ${result.cli.err}`);
      strictEqual(result.cli.err, `Error: ${result.lib.error.message}`, command.name);
      deepStrictEqual([result.cli.requests, result.lib.requests], [[], []], command.name);
    }
  };

  it("refuses tesseract-js without the optional package, the same way through every door", async () => {
    await sameRefusal("tesseract-js");
  });

  it("refuses tesseract without the binary, the same way through every door", async () => {
    const path = process.env["PATH"];
    const empty = mkdtempSync(join(tmpdir(), "openka-empty-path-"));
    process.env["PATH"] = empty;
    try {
      await sameRefusal("tesseract");
    } finally {
      process.env["PATH"] = path;
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("verifying a corpus (finding 13)", () => {
  /** One record, plus a second whose file is corrupt. */
  const seedWithCorrupt = (corpus: string): void => {
    seedOneRecord(corpus);
    const store = new FileStore(corpus);
    const other = sampleRecord({ id: "berlin-19-22222", reference: "19/22222" });
    store.putRecord(other);
    indexRecord(store, other);
    store.flushCatalog();
    writeFileSync(join(corpus, "records", "berlin-19-22222.json"), '{"broken');
  };

  const cases: [string, string[], { all?: boolean; ids?: string[] }][] = [
    ["verify --all", ["--all"], { all: true }],
    ["verify of the corrupt record", ["berlin-19-22222"], { ids: ["berlin-19-22222"] }],
    ["the default sample", [], {}],
  ];
  for (const [label, argv, lib] of cases) {
    it(`${label}: the same rows, and the same unreadable verdict`, async () => {
      let report: unknown;
      const result = await parity({
        seed: seedWithCorrupt,
        argv: (corpus) => ["--compact", "--corpus", corpus, "verify", ...argv, "--json"],
        lib: async ({ store }) => {
          report = await verifyCorpus({ store, env: {}, ...lib });
          assertVerified(report as Awaited<ReturnType<typeof verifyCorpus>>);
        },
      });
      strictEqual(result.cli.code, EXIT_STORE, result.cli.err);
      deepStrictEqual(JSON.parse(result.cli.out), JSON.parse(JSON.stringify(report)));
      ok(!result.lib.ok);
      deepStrictEqual(result.lib.error.name, "StoreError");
      strictEqual(result.cli.err, `Error: ${result.lib.error.message}`);
      ok(/unreadable$/.test(result.lib.error.message), result.lib.error.message);
    });
  }

  it("calls a corpus with no records an error on both sides", async () => {
    let cliRoot = "";
    let libRoot = "";
    const result = await parity({
      seed: (corpus) => {
        new FileStore(corpus).flushCatalog();
      },
      argv: (corpus) => {
        cliRoot = corpus;
        return ["--corpus", corpus, "verify"];
      },
      lib: ({ store }) => {
        libRoot = store.root;
        return verifyCorpus({ store, env: {} });
      },
    });
    strictEqual(result.cli.code, 1, result.cli.err);
    strictEqual(result.cli.err, `Error: No records in ${resolve(cliRoot)}`);
    deepStrictEqual(result.lib, { ok: false, error: { name: "OpenKaError", message: `No records in ${libRoot}` }, requests: [] });
  });
});

describe("a record's archived document (finding 15)", () => {
  /** The blob of the one seeded record's combined PDF. */
  const blobOf = (corpus: string): string => {
    const store = new FileStore(corpus);
    const sha256 = store.getRecord("berlin-19-12345")?.source_documents[0]?.sha256;
    ok(sha256 !== undefined);
    return store.blobPath(sha256);
  };
  const open = (argv: string[] = []) => (corpus: string): string[] => ["--corpus", corpus, "open", "berlin-19-12345", ...argv];

  it("prints the path archivedDocument returns", async () => {
    let cliCorpus = "";
    let libCorpus = "";
    const result = await parity({
      seed: seedOneRecord,
      argv: (corpus) => open()((cliCorpus = corpus)),
      lib: ({ store, corpus }) => {
        libCorpus = corpus;
        return archivedDocument(store, "berlin-19-12345").path;
      },
    });
    strictEqual(result.cli.code, 0, result.cli.err);
    ok(result.lib.ok);
    strictEqual(relative(cliCorpus, result.cli.out), relative(libCorpus, result.lib.value as string));
    strictEqual(result.cli.err, "combined_pdf · https://example.invalid/19-12345.pdf");
  });

  const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const [label, damage, expected] of [
    ["missing", (blob: string) => rmSync(blob), (_blob: string) => /^The archived bytes for https:\/\/example\.invalid\/19-12345\.pdf \([0-9a-f]{64}\) are missing\.$/],
    ["corrupt", (blob: string) => writeFileSync(blob, "not the archived bytes"), (blob: string) => new RegExp(`^The archived bytes ${escape(blob)} are corrupt: they hash to [0-9a-f]{64}, not to their name$`)],
  ] as const) {
    it(`refuses ${label} archived bytes as a corpus problem on both sides`, async () => {
      const blobs: string[] = [];
      const result = await parity({
        seed: (corpus) => {
          seedOneRecord(corpus);
          blobs.push(blobOf(corpus));
          damage(blobs[blobs.length - 1] as string);
        },
        argv: open(),
        lib: ({ store }) => archivedDocument(store, "berlin-19-12345"),
      });
      const [cliBlob, libBlob] = blobs as [string, string];
      strictEqual(result.cli.code, EXIT_STORE, result.cli.err);
      ok(result.cli.err.startsWith("Error: "));
      match(result.cli.err.slice("Error: ".length), expected(cliBlob));
      ok(!result.lib.ok);
      strictEqual(result.lib.error.name, "StoreError");
      match(result.lib.error.message, expected(libBlob));
    });
  }

  it("refuses a role that does not exist on both sides", async () => {
    for (const role of ["bogus", " combined_pdf"]) {
      const result = await parity({
        seed: seedOneRecord,
        argv: open(["--role", role]),
        lib: ({ store }) => archivedDocument(store, "berlin-19-12345", { role }),
      });
      bothRefused(result, "role", "Allowed choices are question_pdf, answer_pdf, combined_pdf, metadata.");
    }
  });

  it("says the same when the record has no archived document with that role", async () => {
    const result = await parity({
      seed: seedOneRecord,
      argv: open(["--role", "answer_pdf"]),
      lib: ({ store }) => archivedDocument(store, "berlin-19-12345", { role: "answer_pdf" }),
    });
    strictEqual(result.cli.code, 1, result.cli.err);
    ok(!result.lib.ok);
    strictEqual(result.lib.error.name, "OpenKaError");
    strictEqual(result.cli.err, `Error: ${result.lib.error.message}`);
    match(result.lib.error.message, /^Record berlin-19-12345 has no archived document with role answer_pdf\./);
  });
});

describe("semantic search's total (finding 16)", () => {
  /** Four Berlin records, each with a frozen vector. */
  const seedVectors = (corpus: string): void => {
    const store = new FileStore(corpus);
    for (const n of ["1", "2", "3", "4"]) {
      const record = sampleRecord({ id: `berlin-19-${n}`, reference: `19/${n}` });
      store.putRecord(record);
      indexRecord(store, record);
    }
    store.flushCatalog();
    store.saveEmbeddings({ model: "test", dimensions: 2, vectors: { "berlin-19-1": [1, 0], "berlin-19-2": [0.9, 0.1], "berlin-19-3": [0.8, 0.2], "berlin-19-4": [0.1, 0.9] } });
  };

  it("counts every similar record before the page is cut, on both sides", async () => {
    const result = await parity({
      seed: seedVectors,
      argv: (corpus) => ["--compact", "--corpus", corpus, "search", "--json", "--like", "berlin-19-1", "--limit", "1"],
      lib: ({ store }) => searchLike(store, "berlin-19-1", { limit: 1 }),
    });
    strictEqual(result.cli.code, 0, result.cli.err);
    deepStrictEqual(result.lib, { ok: true, value: JSON.parse(result.cli.out), requests: [] });
    const value = (result.lib as { value: { total: number; hits: unknown[] } }).value;
    deepStrictEqual([value.total, value.hits.length], [3, 1]);
  });

  it("notes the page against the total on stderr, like keyword search", async () => {
    const result = await parity({
      seed: seedVectors,
      argv: (corpus) => ["--corpus", corpus, "search", "--like", "berlin-19-1", "--limit", "2"],
      lib: ({ store }) => searchLike(store, "berlin-19-1", { limit: 2 }).total,
    });
    strictEqual(result.cli.code, 0, result.cli.err);
    strictEqual(result.cli.err, "2 of 3 similar record(s).");
    deepStrictEqual(result.lib, { ok: true, value: 3, requests: [] });
  });
});

describe("a source's politeness floor (#12)", () => {
  // Brandenburg declares 4000 ms between requests to one host. The floor belongs to
  // the Source contract, so sync() applies it; ka sync keeps no copy of the rule.
  const { readFixtureText } = fixturesOf("@maschinenlesbar.org/openka-lib-parlamentsspiegel", import.meta.url);
  const RESULTS = readFixtureText("payloads", "parlamentsspiegel-results.html");
  const responder: Transport = async (request) => {
    const answer = (status: number, body: string) => ({ status, headers: {}, body: Buffer.from(body, "utf8") });
    // robots.txt with the rule lifted: the floor still holds.
    if (request.url.endsWith("/robots.txt")) return answer(200, "User-agent: *\nDisallow: /files/\n");
    if (request.url.includes("/suche")) return answer(200, RESULTS);
    return answer(404, "");
  };
  const pacing = (sides: number[][]) => () => {
    const slept: number[] = [];
    sides.push(slept);
    let clock = 0;
    return {
      now: () => clock,
      sleep: async (ms: number) => {
        slept.push(ms);
        clock += ms;
      },
    };
  };

  it("paces sync at the source's floor on both sides, above a lower global interval", async () => {
    const sides: number[][] = [];
    const result = await parity({
      responder,
      pacing: pacing(sides),
      argv: (corpus) => ["--corpus", corpus, "--min-host-interval", "100", "sync", "--source", "brandenburg", "--limit", "3", "--json"],
      lib: ({ engine, store }) => sync({ source: createSource("brandenburg"), store, engine, limit: 3, now: () => new Date("2026-01-02T03:04:05Z") }),
    });
    const [cliSlept, libSlept] = sides;
    ok(result.lib.ok, JSON.stringify(result.lib));
    deepStrictEqual(result.cli.requests, result.lib.requests);
    ok((cliSlept ?? []).length > 0, "the run made more than one request to one host");
    deepStrictEqual(libSlept, cliSlept);
    ok((libSlept ?? []).every((ms) => ms === 4000), JSON.stringify(libSlept));
  });
});

describe("a malformed record id or an unknown source key (#17)", () => {
  const RECORD_ID = "Not a record id: expected lower-case letters, digits, '.', '_' and '-', like berlin-19-10006.";

  for (const source of ["narnia", "Bund", " bund", "bund "]) {
    it(`refuses sync --source ${JSON.stringify(source)} on both sides, as a usage error`, async () => {
      const result = await parity({
        argv: (corpus) => ["--corpus", corpus, "sync", "--source", source],
        lib: () => createSource(source),
      });
      bothRefused(result, "source", `Unknown source "${source}". Known sources: ${sourceKeys().join(", ")}.`);
    });
  }

  it("refuses a blank --source the same way on both sides", async () => {
    const result = await parity({
      argv: (corpus) => ["--corpus", corpus, "sync", "--source", " "],
      lib: () => createSource(" "),
    });
    bothRefused(result, "source", BLANK);
  });

  for (const id of ["BERLIN-19-12345", "../x", "a..b"]) {
    it(`refuses get/show/verify ${JSON.stringify(id)} on both sides, as a usage error`, async () => {
      for (const [command, lib] of [
        ["get", ({ store }: { store: FileStore }) => store.getRecord(id)],
        ["show", ({ store }: { store: FileStore }) => store.getRecord(id)],
        ["verify", ({ store }: { store: FileStore }) => verifyRecord(id, { store })],
      ] as const) {
        const result = await parity({ seed: seedOneRecord, argv: (corpus) => ["--corpus", corpus, command, id], lib });
        bothRefused(result, "id", RECORD_ID);
      }
    });
  }
});
