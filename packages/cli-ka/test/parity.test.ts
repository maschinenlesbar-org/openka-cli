// CLI <-> library parity: the same input through `run()` and through the library
// function the CLI wraps must give the same outcome. Each `describe` below pins one
// rule that used to live only in a commander parser or a command action.

import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStore, corpusStats, indexRecord, markHumanVerified } from "@maschinenlesbar.org/openka-lib-store";
import { sourceStatus } from "@maschinenlesbar.org/openka-lib-pipeline";
import { SOURCE_REGISTRY } from "@maschinenlesbar.org/openka-lib-registry";
import { sampleRecord } from "@maschinenlesbar.org/openka-lib-testing";
import {
  BASELINE_FILE,
  DEFAULT_DIMENSIONS,
  MAX_DIMENSIONS,
  MIN_DIMENSIONS,
  addGolden,
  baselinePath,
  buildEmbeddings,
  detectDrift,
  importEmbeddings,
  listAllGoldens,
  loadBaseline,
  loadCorpusBaseline,
  measureHealth,
  saveBaseline,
  saveCorpusBaseline,
} from "@maschinenlesbar.org/openka-cli-ka-factory";
import { reviewQueue, search, searchLike, selectRecords, type SearchFilters } from "@maschinenlesbar.org/openka-lib-search";
import { renderAtom, renderRecord } from "@maschinenlesbar.org/openka-lib-render";
import { canonicalJsonLine } from "@maschinenlesbar.org/openka-lib-repro";
import { rmSync } from "node:fs";
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
  const exportedIds = (jsonl: string): string[] => [...jsonl.matchAll(/^ {2}"id": "([^"]+)"/gm)].map((m) => m[1] as string);

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
      lib: ({ store }) => selectRecords(store, "").records.map((record) => canonicalJsonLine(record).replace(/\n+$/, "")).join("\n"),
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
      lib: ({ store }) => ({ hits: searchLike(store, "berlin-19-1", { parliament: ["Berlin"] }) }),
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
