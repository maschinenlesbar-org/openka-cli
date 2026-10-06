// The CLI, driven in-process through `run()` with a real temporary corpus, a
// scripted transport and a fixed clock. No subprocess, no network.

import { deepStrictEqual, doesNotMatch, match, ok, strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT_ERROR, EXIT_OK, EXIT_STORE, EXIT_USAGE, run } from "../src/run.js";
import { runFactory } from "@maschinenlesbar.org/openka-cli-ka-factory";
import { parseIsoDate, parseBoundedInt, parseNonEmpty } from "../src/shared.js";
import { FileStore, resolveCorpusRoot, toCatalogEntry } from "@maschinenlesbar.org/openka-lib-store";
import { escapeControlChars, sanitizeForTerminal, truncate } from "../src/text.js";
import { formatHit, renderShowLines } from "../src/commands/query.js";
import { sampleRecord, scriptedTransport, fixturesOf } from "@maschinenlesbar.org/openka-lib-testing";
import { cliHarness } from "./harness.js";
import { defaultIO, handleOutputErrors } from "../src/io.js";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";

// Real documents come from the connector that recorded them: one copy of the
// bytes, and the borrowing is visible as a devDependency.
const { readFixture } = fixturesOf("@maschinenlesbar.org/openka-connector-berlin", import.meta.url);
const { readFixtureText } = fixturesOf("@maschinenlesbar.org/openka-lib-pardok", import.meta.url);

const PDF = readFixture(
  "berlin",
  "berlin-19-10006",
  "7d0515afe6e596c8913c4353b6b89dbbb4da5c5ae4092a2cecb2a8660bf774ad.bin",
);
const PARDOK = readFixtureText("payloads", "pardok-sample.xml");

function berlinTransport(): ReturnType<typeof scriptedTransport> {
  return scriptedTransport([
    { match: "pardok-wp19.xml", body: PARDOK, headers: { etag: '"feed-v1"' } },
    { match: ".pdf", body: PDF, headers: { etag: '"pdf-v1"' } },
  ]);
}

/** Sync the Berlin fixture feed into a fresh corpus and return the harness. */
async function seeded(): Promise<ReturnType<typeof cliHarness>> {
  const harness = cliHarness({ transport: berlinTransport().transport });
  const code = await run(["--corpus", harness.corpus, "sync", "--source", "berlin"], harness.deps);
  strictEqual(code, EXIT_OK, harness.stderr());
  harness.out.length = 0;
  harness.err.length = 0;
  return harness;
}

describe("option parsers", () => {
  it("rejects a blank filter rather than silently dropping it", () => {
    let threw = false;
    try {
      parseNonEmpty("   ");
    } catch {
      threw = true;
    }
    ok(threw);
  });

  it("bounds an integer and rejects a non-decimal form", () => {
    strictEqual(parseBoundedInt(0, 10)("5"), 5);
    for (const bad of ["0x10", "1e2", " 5 ", "11", "-1"]) {
      let threw = false;
      try {
        parseBoundedInt(0, 10)(bad);
      } catch {
        threw = true;
      }
      ok(threw, `expected ${bad} to be rejected`);
    }
  });

  it("accepts only a real calendar date", () => {
    strictEqual(parseIsoDate("2024-02-29"), "2024-02-29");
    let threw = false;
    try {
      parseIsoDate("2023-02-29");
    } catch {
      threw = true;
    }
    ok(threw);
  });

  it("resolves the corpus root from the environment, through the library", () => {
    match(resolveCorpusRoot({ env: { OPENKA_CORPUS: "/tmp/x" } }), /\/tmp\/x$/);
    match(resolveCorpusRoot({ env: { XDG_DATA_HOME: "/tmp/share" } }), /\/tmp\/share\/openka$/);
    match(resolveCorpusRoot({ env: {} }), /\.local\/share\/openka$/);
  });
});

describe("terminal-safe text", () => {
  it("escapes the control characters JSON leaves raw", () => {
    strictEqual(escapeControlChars('"a\u009bb"'), '"a\\u009bb"');
  });

  it("strips escape sequences from upstream text", () => {
    strictEqual(sanitizeForTerminal("a\u001b[31mb"), "a [31mb");
  });

  it("truncates with an ellipsis", () => {
    strictEqual(truncate("abcdef", 4), "abc…");
  });

  // Finding 01#2: the listed date is the one the date filters use, the question's.
  it("lists a record without a question date as undated, not at its answer's date", () => {
    const entry = toCatalogEntry(sampleRecord({ dates: { answered: "2025-05-14" } }), 1);
    doesNotMatch(formatHit(entry, 0), /2025-05-14/);
    match(formatHit(entry, 0), /— {9}/);
    match(formatHit(toCatalogEntry(sampleRecord({ dates: { submitted: "2025-02-14", answered: "2025-05-14" } }), 1), 0), /2025-02-14/);
  });

  // Finding 03#6: an override reached the terminal, and truncation cut off its end.
  it("strips bidi controls, so no title reverses the rest of a line", () => {
    strictEqual(sanitizeForTerminal("a\u202egnirts\u202c b\u2066c\u2069\u200f"), "agnirts bc");
    strictEqual(truncate("\u202egnirtsgnirtsgnirts\u202c", 5), "gnir…");
    const lines = renderShowLines(sampleRecord({ title: "Titel \u202eesrever\u202c" })).join("\n");
    doesNotMatch(lines, /[\u202a-\u202e\u2066-\u2069]/);
  });
});

describe("ka", () => {
  it("prints help and exits 0", async () => {
    const harness = cliHarness();
    strictEqual(await run(["--help"], harness.deps), EXIT_OK);
    match(harness.stdout(), /Usage: ka/);
    match(harness.stdout(), /abstained_fields/);
    harness.cleanup();
  });

  it("maps an unknown command to a usage error", async () => {
    const harness = cliHarness();
    strictEqual(await run(["frobnicate"], harness.deps), EXIT_USAGE);
    harness.cleanup();
  });

  it("maps a rejected option value to a usage error", async () => {
    const harness = cliHarness();
    strictEqual(await run(["--corpus", harness.corpus, "sync", "--source", "berlin", "--since", "nope"], harness.deps), EXIT_USAGE);
    harness.cleanup();
  });

  it("prints the JSON Schema", async () => {
    const harness = cliHarness();
    strictEqual(await run(["schema"], harness.deps), EXIT_OK);
    const schema = JSON.parse(harness.stdout()) as Record<string, unknown>;
    strictEqual(schema["title"], "OpenKA record");
    harness.cleanup();
  });

  it("lists every source with its status", async () => {
    const harness = cliHarness();
    strictEqual(await run(["--corpus", harness.corpus, "sources", "list"], harness.deps), EXIT_OK);
    match(harness.stdout(), /berlin\s+implemented/);
    match(harness.stdout(), /hessen\s+via_aggregator/);
    harness.cleanup();
  });

  it("explains what one source does", async () => {
    const harness = cliHarness();
    strictEqual(await run(["--corpus", harness.corpus, "sources", "show", "bund"], harness.deps), EXIT_OK);
    match(harness.stdout(), /credential: --api-key or DIP_API_KEY/);
    harness.cleanup();
  });

  it("syncs, searches, shows and gets a record", async () => {
    const harness = await seeded();
    try {
      strictEqual(await run(["--corpus", harness.corpus, "stats"], harness.deps), EXIT_OK);
      match(harness.stdout(), /record\(s\) in/);

      harness.out.length = 0;
      strictEqual(await run(["--corpus", harness.corpus, "search", "solaranlagen"], harness.deps), EXIT_OK);
      match(harness.stdout(), /berlin-19-10006/);

      harness.out.length = 0;
      strictEqual(await run(["--corpus", harness.corpus, "show", "berlin-19-10006"], harness.deps), EXIT_OK);
      match(harness.stdout(), /Frage 1:/);
      match(harness.stdout(), /Abgeordnetenhaus von Berlin/);

      harness.out.length = 0;
      strictEqual(await run(["--corpus", harness.corpus, "get", "berlin-19-10006", "--format", "md"], harness.deps), EXIT_OK);
      match(harness.stdout(), /## Frage 1/);
    } finally {
      harness.cleanup();
    }
  });

  it("verifies a synced record byte for byte", async () => {
    const harness = await seeded();
    try {
      strictEqual(await run(["--corpus", harness.corpus, "verify", "berlin-19-10006"], harness.deps), EXIT_OK);
      match(harness.stdout(), /1\/1 record\(s\) reproduced byte-identically/);
    } finally {
      harness.cleanup();
    }
  });

  it("exits non-zero when a record does not reproduce", async () => {
    const harness = await seeded();
    try {
      const store = harness.deps.createStore(harness.corpus);
      const record = store.getRecord("berlin-19-10006");
      ok(record !== undefined);
      record.title = "Ein anderer Titel";
      record.id = record.id; // id is unchanged; only a document-derived field moves
      record.qa[0] = { ...record.qa[0], answer: "erfunden" } as never;
      store.putRecord(record);
      strictEqual(await run(["--corpus", harness.corpus, "verify", "berlin-19-10006"], harness.deps), EXIT_ERROR);
      match(harness.stdout(), /FAIL berlin-19-10006/);
      match(harness.stdout(), /differs at qa\[0\]\.answer/);
    } finally {
      harness.cleanup();
    }
  });

  it("names archived bytes that no longer match their digest, instead of blaming the extractor", async () => {
    const harness = await seeded();
    try {
      const store = harness.deps.createStore(harness.corpus);
      const digest = store.getRecord("berlin-19-10006")?.source_documents[0]?.sha256;
      ok(digest !== undefined);
      writeFileSync(store.blobPath(digest), "%PDF-1.4 not the archived document");
      strictEqual(await run(["--corpus", harness.corpus, "verify", "berlin-19-10006"], harness.deps), EXIT_STORE);
      match(harness.stdout(), /FAIL berlin-19-10006: archived bytes for .* are unreadable: .* are corrupt: they hash to [0-9a-f]{64}, not to their name/);
      doesNotMatch(harness.stdout(), /different bytes with the same extractor version/);
      harness.err.length = 0;
      strictEqual(await run(["--corpus", harness.corpus, "open", "berlin-19-10006"], harness.deps), EXIT_STORE);
      match(harness.stderr(), /are corrupt/);
      // The same bytes, fetched again, repair the file rather than being skipped.
      store.putBlob(PDF);
      strictEqual(await run(["--corpus", harness.corpus, "verify", "berlin-19-10006"], harness.deps), EXIT_OK);
    } finally {
      harness.cleanup();
    }
  });

  it("prints the path of an archived document", async () => {
    const harness = await seeded();
    try {
      strictEqual(await run(["--corpus", harness.corpus, "open", "berlin-19-10006"], harness.deps), EXIT_OK);
      match(harness.stdout(), /blobs\/[0-9a-f]{2}\/[0-9a-f]{64}\.bin$/);
    } finally {
      harness.cleanup();
    }
  });

  it("reports a missing record as an error, not as an empty result", async () => {
    const harness = cliHarness();
    strictEqual(await run(["--corpus", harness.corpus, "show", "berlin-19-99999"], harness.deps), EXIT_ERROR);
    match(harness.stderr(), /No record berlin-19-99999/);
    harness.cleanup();
  });

  it("stops a sync on Ctrl-C after the Anfrage in hand, saves the catalog and exits 130", async () => {
    const scripted = berlinTransport();
    let interrupt: ((signal: "SIGINT" | "SIGTERM") => void) | undefined;
    let listening = false;
    const harness = cliHarness({
      transport: async (request) => {
        const response = await scripted.transport(request);
        // The signal arrives while the first document is being fetched.
        if (request.url.endsWith(".pdf")) interrupt?.("SIGINT");
        return response;
      },
    });
    harness.deps.onInterrupt = (handler) => {
      interrupt = handler;
      listening = true;
      return () => {
        listening = false;
      };
    };
    try {
      strictEqual(await run(["--corpus", harness.corpus, "sync", "--source", "berlin"], harness.deps), 130);
      strictEqual(listening, false, "the listener is removed when the sync returns");
      match(harness.stderr(), /Interrupted — finishing the current Anfrage/);
      match(harness.stderr(), /stopped after 1 of \d+ Anfragen; what was stored is catalogued/);
      harness.out.length = 0;
      strictEqual(await run(["--corpus", harness.corpus, "stats", "--json"], harness.deps), EXIT_OK);
      strictEqual((JSON.parse(harness.stdout()) as { records: number }).records, 1);
    } finally {
      harness.cleanup();
    }
  });

  it("refuses to write a corpus another run holds, with exit 3 and the lock file to delete", async () => {
    const harness = await seeded();
    try {
      const release = new FileStore(harness.corpus).lock("sync --source berlin");
      strictEqual(await run(["--corpus", harness.corpus, "reindex"], harness.deps), EXIT_STORE);
      match(harness.stderr(), /in use by another run \(sync --source berlin, pid \d+.*delete .*lock/);
      strictEqual(await run(["--corpus", harness.corpus, "review", "--mark-verified", "berlin-19-10006"], harness.deps), EXIT_STORE);
      // Reading is not writing: search and stats do not wait for the lock.
      strictEqual(await run(["--corpus", harness.corpus, "stats"], harness.deps), EXIT_OK);
      release();
      strictEqual(await run(["--corpus", harness.corpus, "reindex"], harness.deps), EXIT_OK);
    } finally {
      harness.cleanup();
    }
  });

  it("skips the files macOS leaves on a FAT drive and says so once, instead of stopping", async () => {
    const harness = await seeded();
    try {
      writeFileSync(join(harness.corpus, "records", "._berlin-19-10006.json"), "\0\u0005\u0016\u0007");
      writeFileSync(join(harness.corpus, "records", ".DS_Store"), "");
      for (const argv of [["stats"], ["verify", "--all"], ["reindex"], ["search", "solaranlagen"]]) {
        harness.err.length = 0;
        strictEqual(await run(["--corpus", harness.corpus, ...argv], harness.deps), EXIT_OK, argv.join(" "));
        if (argv[0] !== "search") {
          match(harness.stderr(), /^Note: ignored 2 macOS AppleDouble\/\.DS_Store file\(s\) in the corpus; `dot_clean .*` removes them\.$/m);
        }
      }
      // A name the store would never write still stops: that is the guard against path tricks.
      writeFileSync(join(harness.corpus, "records", "Bad.json"), "{}");
      strictEqual(await run(["--corpus", harness.corpus, "stats"], harness.deps), EXIT_STORE);
      match(harness.stderr(), /Unsafe record file "Bad\.json"/);
    } finally {
      harness.cleanup();
    }
  });

  it("reports sync progress on stderr, also with --json, and not with --quiet", async () => {
    for (const [argv, expected] of [
      [["sync", "--source", "berlin"], true],
      [["sync", "--source", "berlin", "--json"], true],
      [["--quiet", "sync", "--source", "berlin"], false],
    ] as const) {
      const harness = cliHarness({ transport: berlinTransport().transport });
      try {
        strictEqual(await run(["--corpus", harness.corpus, ...argv], harness.deps), EXIT_OK);
        const progress = /^berlin: \d+ Anfragen discovered$[\s\S]*^berlin: (\d+)\/\1 · 0 failed$/m;
        if (expected) match(harness.stderr(), progress, argv.join(" "));
        else strictEqual(harness.stderr(), "", argv.join(" "));
        if ((argv as readonly string[]).includes("--json")) JSON.parse(harness.stdout());
      } finally {
        harness.cleanup();
      }
    }
  });

  it("syncs several sources in one run, and prints a report per source", async () => {
    const twoSources = (): ReturnType<typeof scriptedTransport> =>
      scriptedTransport([
        { match: "pardok-wp19.xml", body: PARDOK },
        { match: "robots.txt", status: 404 },
        { match: ".pdf", body: PDF },
        { match: "search.dip.bundestag.de", body: '{"numFound":0,"documents":[]}', headers: { "content-type": "application/json" } },
      ]);
    const harness = cliHarness({ transport: twoSources().transport, env: { DIP_API_KEY: "test-key" } });
    try {
      strictEqual(await run(["--corpus", harness.corpus, "sync", "--source", "berlin", "--source", "bund"], harness.deps), EXIT_OK, harness.stderr());
      match(harness.stdout(), /^berlin: \d+ discovered, \d+ stored/m);
      match(harness.stdout(), /^bund: 0 discovered, 0 stored, 0 unchanged, 0 failed$/m);

      harness.out.length = 0;
      strictEqual(await run(["--corpus", harness.corpus, "sync", "--source", "berlin", "--source", "bund", "--json"], harness.deps), EXIT_OK);
      const reports = JSON.parse(harness.stdout()) as { source: string; unchanged: number }[];
      deepStrictEqual(reports.map((report) => report.source), ["berlin", "bund"]);
    } finally {
      harness.cleanup();
    }
  });

  it("asks for --source or --all, never both", async () => {
    const harness = cliHarness();
    try {
      strictEqual(await run(["--corpus", harness.corpus, "sync"], harness.deps), EXIT_USAGE);
      match(harness.stderr(), /Name a source with --source <key>, or sync every one with --all\./);
      strictEqual(await run(["--corpus", harness.corpus, "sync", "--all", "--source", "berlin"], harness.deps), EXIT_USAGE);
      match(harness.stderr(), /--all already names every source/);
    } finally {
      harness.cleanup();
    }
  });

  it("skips a source without its credential under --all, and names it", async () => {
    // Everything but Berlin answers 404 here, so the others fail; what matters is
    // that the Bundestag, which needs a key, was not even started.
    const { transport, requests } = scriptedTransport([
      { match: "pardok-wp19.xml", body: PARDOK },
      { match: ".pdf", body: PDF },
      { match: /./, status: 404 },
    ]);
    const harness = cliHarness({ transport });
    try {
      await run(["--corpus", harness.corpus, "sync", "--all", "--limit", "1"], harness.deps);
      match(harness.stderr(), /^Note: skipped bund: it needs a credential \(--api-key or DIP_API_KEY\)\.$/m);
      ok(!requests.some((request) => request.url.includes("dip.bundestag.de")));
      match(harness.stdout(), /^berlin: 1 discovered, 1 stored/m);
    } finally {
      harness.cleanup();
    }
  });

  it("waits for the corpus with --wait, where it would exit 3 without", async () => {
    const harness = cliHarness({ transport: berlinTransport().transport });
    try {
      const release = new FileStore(harness.corpus).lock("sync --source bund");
      strictEqual(await run(["--corpus", harness.corpus, "sync", "--source", "berlin"], harness.deps), EXIT_STORE);
      setTimeout(release, 100);
      strictEqual(await run(["--corpus", harness.corpus, "sync", "--source", "berlin", "--wait"], harness.deps), EXIT_OK);
      match(harness.stderr(), /^Waiting for the corpus: it is in use by another run \(sync --source bund, pid \d+/m);
      match(harness.stdout(), /^berlin: \d+ discovered/m);
    } finally {
      harness.cleanup();
    }
  });

  it("says what a sync would do with --dry-run, and does none of it", async () => {
    const { transport, requests } = scriptedTransport([
      { match: "pardok-wp19.xml", body: PARDOK },
      { match: "robots.txt", status: 404 },
      { match: ".pdf", headers: { "content-length": "110000" } },
    ]);
    const harness = cliHarness({ transport });
    try {
      strictEqual(await run(["--corpus", harness.corpus, "sync", "--source", "berlin", "--dry-run"], harness.deps), EXIT_OK, harness.stderr());
      match(harness.stdout(), /^berlin \(default window\): \d+ Anfragen discovered, 0 already in corpus$/m);
      match(harness.stdout(), /^documents to fetch: \d+ \(≈ [\d.]+ (KB|MB) at 110 KB avg; HEAD-sampled n=\d+\)$/m);
      deepStrictEqual([...new Set(requests.filter((request) => request.url.endsWith(".pdf")).map((request) => request.method))], ["HEAD"]);
      ok(!existsSync(join(harness.corpus, "records")) && !existsSync(join(harness.corpus, "state")), "nothing is written");

      harness.out.length = 0;
      strictEqual(await run(["--corpus", harness.corpus, "--quiet", "sync", "--source", "berlin", "--dry-run", "--json", "--since", "2021-01-01"], harness.deps), EXIT_OK);
      const plan = JSON.parse(harness.stdout()) as { source: string; window: unknown; documents_to_fetch: number };
      deepStrictEqual([plan.source, plan.window], ["berlin", { since: "2021-01-01" }]);
    } finally {
      harness.cleanup();
    }
  });

  it("adds what the corpus takes on disk to stats with --disk", async () => {
    const harness = await seeded();
    try {
      strictEqual(await run(["--corpus", harness.corpus, "stats", "--disk"], harness.deps), EXIT_OK);
      match(harness.stdout(), /^On disk: blobs \d+ KB in 1 file\(s\), records [\d.]+ KB in \d+ file\(s\), index [\d.]+ KB in \d+ file\(s\)$/m);
      match(harness.stdout(), /^ {2}berlin: 1 document\(s\), \d+ KB \(avg \d+ KB\)$/m);
      harness.out.length = 0;
      strictEqual(await run(["--corpus", harness.corpus, "stats", "--json"], harness.deps), EXIT_OK);
      ok(!("disk" in (JSON.parse(harness.stdout()) as object)), "only when asked: listing every file costs a stat each");
    } finally {
      harness.cleanup();
    }
  });

  it("counts each upstream beside the corpus with sources count", async () => {
    const countPage = '<b>69.935</b> <span>Vorgänge</span>';
    const { transport, requests } = scriptedTransport([
      { match: "parlamentsspiegel.de/suche", body: countPage },
      { match: "/api/v1/vorgang", body: '{"numFound":41900}' },
    ]);
    const harness = cliHarness({ transport, env: { DIP_API_KEY: "test-key" } });
    try {
      strictEqual(await run(["--corpus", harness.corpus, "sources", "count", "--source", "bund", "--source", "berlin"], harness.deps), EXIT_OK, harness.stderr());
      match(harness.stdout(), /^SOURCE +UPSTREAM +IN CORPUS +MISSING +BASIS$/m);
      match(harness.stdout(), /^bund +41,900 +0 +41,900 +DIP numFound$/m);
      match(harness.stdout(), /^berlin +69,935 +0 +69,935 +Parlamentsspiegel$/m);
      match(harness.stdout(), /^total +111,835 +0 +111,835$/m);
      strictEqual(requests.length, 2, "one request per source, no download");

      // Named alone, a count the upstream cannot give is the command's own error.
      strictEqual(await run(["--corpus", harness.corpus, "sources", "count", "--source", "berlin", "--period", "19"], harness.deps), EXIT_USAGE);
      match(harness.stderr(), /cannot count by Wahlperiode/);
    } finally {
      harness.cleanup();
    }
  });

  it("keeps the documents on another drive with --blobs, and reads without them when it is away", async () => {
    const drive = mkdtempSync(join(tmpdir(), "openka-drive-"));
    const harness = cliHarness({ transport: berlinTransport().transport, env: { OPENKA_BLOBS: join(drive, "blobs") } });
    try {
      // First use: the directory must exist — a path on an unplugged drive is never created.
      strictEqual(await run(["--corpus", harness.corpus, "sync", "--source", "berlin"], harness.deps), EXIT_STORE);
      match(harness.stderr(), /blob store .*blobs is not available — is its drive mounted\? On first use, create the directory\./);
      ok(!existsSync(join(drive, "blobs")));

      mkdirSync(join(drive, "blobs"));
      strictEqual(await run(["--corpus", harness.corpus, "sync", "--source", "berlin"], harness.deps), EXIT_OK, harness.stderr());
      ok(!existsSync(join(harness.corpus, "blobs")), "nothing of the documents in the corpus");
      strictEqual(await run(["--corpus", harness.corpus, "verify", "--all"], harness.deps), EXIT_OK);

      rmSync(join(drive, "blobs"), { recursive: true }); // the drive is unplugged
      for (const argv of [["search", "solaranlagen"], ["get", "berlin-19-10006"], ["stats"], ["export", "--format", "csv"], ["review"]]) {
        strictEqual(await run(["--corpus", harness.corpus, ...argv], harness.deps), EXIT_OK, argv.join(" "));
      }
      for (const argv of [["open", "berlin-19-10006"], ["verify", "--all"], ["sync", "--source", "berlin"], ["sync", "--source", "berlin", "--metadata-only"]]) {
        harness.err.length = 0;
        strictEqual(await run(["--corpus", harness.corpus, ...argv], harness.deps), EXIT_STORE, argv.join(" "));
        match(harness.stderr(), /^Error: blob store .* is not available/m, argv.join(" "));
      }
      ok(!existsSync(join(drive, "blobs")));
      strictEqual(await run(["--corpus", harness.corpus, "--blobs", " ", "stats"], harness.deps), EXIT_USAGE);
    } finally {
      harness.cleanup();
      rmSync(drive, { recursive: true, force: true });
    }
  });

  it("groups the review queue by kind of field, and refuses options that do not apply", async () => {
    const harness = await seeded();
    try {
      const store = new FileStore(harness.corpus);
      for (const [id, fields] of [["berlin-19-90001", ["qa[0].answer", "qa[3].answer"]], ["berlin-19-90002", ["qa[1].answer", "dates.answered"]]] as const) {
        const record = sampleRecord({
          id,
          reference: `19/${id.split("-").pop()}`,
          extraction: { ...sampleRecord().extraction, parse_complete: false, abstained_fields: [...fields], review_status: "needs_review" },
        });
        store.putRecord(record);
        store.putCatalogEntry(toCatalogEntry(record, 1));
      }
      strictEqual(await run(["--corpus", harness.corpus, "review", "--group-by", "field"], harness.deps), EXIT_OK, harness.stderr());
      match(harness.stdout(), /^berlin: \d+ record\(s\) in the queue$/m);
      match(harness.stdout(), /^ {2}qa\[\]\.answer +3 +2 {2}berlin-19-90001, berlin-19-90002$/m);
      match(harness.stdout(), /^ {2}dates\.answered +1 +1 {2}berlin-19-90002$/m);
      for (const extra of [["--limit", "5"], ["--mark-verified", "berlin-19-90001"]]) {
        strictEqual(await run(["--corpus", harness.corpus, "review", "--group-by", "field", ...extra], harness.deps), EXIT_USAGE);
      }
      harness.out.length = 0;
      strictEqual(await run(["--corpus", harness.corpus, "stats", "--json"], harness.deps), EXIT_OK);
      const stats = JSON.parse(harness.stdout()) as { by_parliament: Record<string, { abstained_by_field: Record<string, number> }> };
      strictEqual(stats.by_parliament["berlin"]?.abstained_by_field["qa[].answer"], 3);
    } finally {
      harness.cleanup();
    }
  });

  it("warns before a sync onto a volume where macOS writes ._ companions", async () => {
    const harness = cliHarness({ transport: berlinTransport().transport });
    try {
      // What FAT32 does by itself the moment `ka sync` writes its lock file.
      writeFileSync(join(harness.corpus, "._lock"), "");
      strictEqual(await run(["--corpus", harness.corpus, "sync", "--source", "berlin"], harness.deps), EXIT_OK);
      match(harness.stderr(), /^warning: .* is on a volume without extended attributes \(FAT32 or exFAT\).*65,534 entries/m);
      ok(!existsSync(join(harness.corpus, "lock")), "the command's lock is released");

      const clean = cliHarness({ transport: berlinTransport().transport });
      try {
        strictEqual(await run(["--corpus", clean.corpus, "sync", "--source", "berlin"], clean.deps), EXIT_OK);
        doesNotMatch(clean.stderr(), /extended attributes/);
      } finally {
        clean.cleanup();
      }
    } finally {
      harness.cleanup();
    }
  });

  it("calls a missing archived document a corpus problem in verify, as open does", async () => {
    const harness = await seeded();
    try {
      const record = new FileStore(harness.corpus).getRecord("berlin-19-10006");
      const digest = record?.source_documents[0]?.sha256;
      ok(digest !== undefined);
      rmSync(join(harness.corpus, "blobs", digest.slice(0, 2), `${digest}.bin`));
      strictEqual(await run(["--corpus", harness.corpus, "open", "berlin-19-10006"], harness.deps), EXIT_STORE);
      strictEqual(await run(["--corpus", harness.corpus, "verify", "berlin-19-10006"], harness.deps), EXIT_STORE);
      match(harness.stdout(), /FAIL berlin-19-10006: archived bytes .* are missing/);
    } finally {
      harness.cleanup();
    }
  });

  it("names catalog rows whose record file is gone in search, stats and verify", async () => {
    const harness = await seeded();
    try {
      rmSync(join(harness.corpus, "records", "berlin-19-10006.json"));
      strictEqual(await run(["--corpus", harness.corpus, "search", "solaranlagen"], harness.deps), EXIT_OK);
      match(harness.stderr(), /1 of these catalog row\(s\) have no record file: berlin-19-10006/);
      for (const argv of [["stats"], ["verify", "--all"]]) {
        harness.err.length = 0;
        await run(["--corpus", harness.corpus, ...argv], harness.deps);
        match(harness.stderr(), /catalog row\(s\) have no record file, so they are counted and listed but cannot be read: berlin-19-10006/);
      }
    } finally {
      harness.cleanup();
    }
  });

  it("names record files the catalog lacks in stats and verify", async () => {
    const harness = await seeded();
    try {
      rmSync(join(harness.corpus, "index", "catalog.json"));
      strictEqual(await run(["--corpus", harness.corpus, "stats"], harness.deps), EXIT_OK);
      match(harness.stderr(), /record file\(s\) are not in the catalog.*`ka reindex` adds them/);
      harness.err.length = 0;
      strictEqual(await run(["--corpus", harness.corpus, "verify", "--all"], harness.deps), EXIT_OK);
      match(harness.stderr(), /not in the catalog/);
      harness.err.length = 0;
      strictEqual(await run(["--corpus", harness.corpus, "reindex"], harness.deps), EXIT_OK);
      strictEqual(await run(["--corpus", harness.corpus, "stats"], harness.deps), EXIT_OK);
      doesNotMatch(harness.stderr(), /not in the catalog/);
    } finally {
      harness.cleanup();
    }
  });

  it("exports CSV and writes a feed to a file", async () => {
    const harness = await seeded();
    try {
      strictEqual(await run(["--corpus", harness.corpus, "export", "--format", "csv"], harness.deps), EXIT_OK);
      match(harness.stdout(), /^id,parliament,/m);

      strictEqual(await run(["--corpus", harness.corpus, "feed", "--out", "/tmp/openka-test.atom"], harness.deps), EXIT_OK);
      const written = harness.files.get("/tmp/openka-test.atom");
      ok(written !== undefined);
      match(written.toString("utf8"), /<feed xmlns="http:\/\/www\.w3\.org\/2005\/Atom">/);
      // The clock is injected, so the feed's timestamp is reproducible.
      match(written.toString("utf8"), /<updated>2026-01-02T03:04:05Z<\/updated>/);
    } finally {
      harness.cleanup();
    }
  });

  it("works the review queue and records a human decision", async () => {
    const harness = cliHarness({ transport: berlinTransport().transport });
    try {
      await run(["--corpus", harness.corpus, "sync", "--source", "berlin", "--metadata-only"], harness.deps);
      harness.out.length = 0;
      strictEqual(await run(["--corpus", harness.corpus, "review"], harness.deps), EXIT_OK);
      match(harness.stdout(), /berlin-19-\d+/);
      match(harness.stdout(), /\s+qa$/m);

      harness.out.length = 0;
      strictEqual(
        await run(["--corpus", harness.corpus, "review", "--mark-verified", "berlin-19-10006"], harness.deps),
        EXIT_OK,
      );
      match(harness.stdout(), /marked human_verified/);
      match(harness.stderr(), /not that they were filled/);
      const store = harness.deps.createStore(harness.corpus);
      strictEqual(store.getRecord("berlin-19-10006")?.extraction.review_status, "human_verified");

      // Finding 02#8: with only verified holes left, the queue is empty — but the
      // records did not extract completely, and the message no longer says so.
      for (const id of store.recordIds().filter((id) => id !== "berlin-19-10006")) {
        await run(["--corpus", harness.corpus, "review", "--mark-verified", id], harness.deps);
      }
      harness.out.length = 0;
      strictEqual(await run(["--corpus", harness.corpus, "review"], harness.deps), EXIT_OK);
      match(harness.stdout(), /Nothing left to review — \d+ record\(s\) with abstained fields were checked by a person/);
      doesNotMatch(harness.stdout(), /extracted completely/);
    } finally {
      harness.cleanup();
    }
  });

  it("rebuilds the index", async () => {
    const harness = await seeded();
    try {
      strictEqual(await run(["--corpus", harness.corpus, "reindex"], harness.deps), EXIT_OK);
      match(harness.stdout(), /Reindexed \d+ record\(s\)/);
    } finally {
      harness.cleanup();
    }
  });

  it("repairs a corrupt catalog with reindex, and checks every record past a corrupt one", async () => {
    const harness = await seeded();
    try {
      const ids = harness.deps.createStore(harness.corpus).recordIds();
      ok(ids.length >= 2, `seeded ${ids.length} record(s)`);
      const broken = ids[0] as string;
      writeFileSync(join(harness.corpus, "records", `${broken}.json`), '{"broken');
      writeFileSync(join(harness.corpus, "index", "catalog.json"), "[1,2");

      // Search names the corpus problem instead of crashing.
      strictEqual(await run(["--corpus", harness.corpus, "search", "solaranlagen"], harness.deps), EXIT_STORE);
      match(harness.stderr(), /Corrupt JSON in .*catalog\.json/);

      // Reindex does not need the catalog it is rebuilding, and indexes the rest.
      harness.err.length = 0;
      strictEqual(await run(["--corpus", harness.corpus, "reindex"], harness.deps), EXIT_STORE);
      match(harness.stdout(), new RegExp(`Reindexed ${ids.length - 1} record\\(s\\)`));
      match(harness.stderr(), new RegExp(`skipped ${broken}: Corrupt record`));
      harness.out.length = 0;
      strictEqual(await run(["--corpus", harness.corpus, "search", "solaranlagen"], harness.deps), EXIT_OK);
      match(harness.stdout(), /berlin-19-10006/);

      // verify --all reports the corrupt record and carries on with the others.
      harness.out.length = 0;
      strictEqual(await run(["--corpus", harness.corpus, "verify", "--all"], harness.deps), EXIT_STORE);
      match(harness.stdout(), new RegExp(`FAIL ${broken}: Corrupt record`));
      match(harness.stdout(), new RegExp(`${ids.length - 1}/${ids.length} record\\(s\\) reproduced`));
    } finally {
      harness.cleanup();
    }
  });

  it("refuses a sync it cannot honour as a usage error, and files no source error for it", async () => {
    // A missing key, a Wahlperiode the feed does not cover and an unknown source
    // exited 1 and left a "last error" in state/ for `sources list` and
    // `ka-factory health` to report against a source that is working fine.
    const harness = cliHarness({ transport: berlinTransport().transport });
    try {
      for (const [argv, message] of [
        [["--source", "bund"], /needs a key/],
        [["--source", "berlin", "--period", "5"], /covers Wahlperioden 11–19; 5 was requested/],
        [["--source", "nordrhein-westfalen", "--period", "13"], /robots\.txt disallows its document archive/],
        [["--source", "narnia"], /Unknown source "narnia"/],
      ] as const) {
        harness.err.length = 0;
        strictEqual(await run(["--corpus", harness.corpus, "sync", ...argv], harness.deps), EXIT_USAGE, argv.join(" "));
        match(harness.stderr(), message);
      }
      ok(!existsSync(join(harness.corpus, "state")), "no source state for refused runs");
    } finally {
      harness.cleanup();
    }
  });

  it("takes a credential from the environment", async () => {
    const { transport, requests } = scriptedTransport([
      { match: "dip", body: JSON.stringify({ numFound: 0, documents: [] }) },
    ]);
    const harness = cliHarness({ transport, env: { DIP_API_KEY: "from-env" } });
    await run(["--corpus", harness.corpus, "sync", "--source", "bund"], harness.deps);
    strictEqual(requests[0]?.headers?.["authorization"], "ApiKey from-env");
    harness.cleanup();
  });

  it("prefers the flag over the environment variable", async () => {
    const { transport, requests } = scriptedTransport([
      { match: "dip", body: JSON.stringify({ numFound: 0, documents: [] }) },
    ]);
    const harness = cliHarness({ transport, env: { DIP_API_KEY: "from-env" } });
    await run(["--corpus", harness.corpus, "sync", "--source", "bund", "--api-key", "from-flag"], harness.deps);
    strictEqual(requests[0]?.headers?.["authorization"], "ApiKey from-flag");
    harness.cleanup();
  });

  it("refuses an OCR sub-option without --ocr rather than ignoring it", async () => {
    // `--ocr-version 5.3.4` on its own used to run strict mode silently.
    const { transport, requests } = berlinTransport();
    const harness = cliHarness({ transport });
    const code = await run(
      ["--corpus", harness.corpus, "sync", "--source", "berlin", "--ocr-language", "deu", "--ocr-version", "5.3.4"],
      harness.deps,
    );
    strictEqual(code, EXIT_USAGE);
    match(harness.stderr(), /--ocr-language, --ocr-version only apply with --ocr/);
    strictEqual(requests.length, 0);
    harness.cleanup();
  });

  it("refuses --ocr tesseract-js when the optional package is absent", async () => {
    const harness = cliHarness({ transport: berlinTransport().transport });
    const code = await run(["--corpus", harness.corpus, "sync", "--source", "berlin", "--ocr", "tesseract-js"], harness.deps);
    strictEqual(code, EXIT_ERROR);
    match(harness.stderr(), /npm install tesseract\.js/);
    harness.cleanup();
  });

  it("tells the user that semantic search needs frozen embeddings", async () => {
    const harness = await seeded();
    try {
      strictEqual(await run(["--corpus", harness.corpus, "search", "--like", "berlin-19-10006"], harness.deps), EXIT_ERROR);
      match(harness.stderr(), /no frozen embeddings/);
    } finally {
      harness.cleanup();
    }
  });

  it("lists the date --from/--to filter on: when the Anfrage was asked", async () => {
    const harness = await seeded();
    try {
      const record = harness.deps.createStore(harness.corpus).getRecord("berlin-19-10006");
      const { submitted, answered } = record?.dates ?? {};
      ok(submitted !== undefined && answered !== undefined && submitted !== answered);
      strictEqual(await run(["--corpus", harness.corpus, "search", "--to", submitted, "solaranlagen"], harness.deps), EXIT_OK);
      match(harness.stdout(), new RegExp(`berlin-19-10006\\s+${submitted}`));
      harness.out.length = 0;
      strictEqual(await run(["--corpus", harness.corpus, "search", "--help"], harness.deps), EXIT_OK);
      match(harness.stdout(), /--from <date>\s+asked on or after this date/);
    } finally {
      harness.cleanup();
    }
  });

  it("refuses a parliament it does not know, instead of answering No matches", async () => {
    const harness = await seeded();
    try {
      for (const argv of [
        ["search", "--parliament", "narnia"],
        ["export", "--parliament", "narnia", "--format", "jsonl"],
        ["feed", "--parliament", "narnia"],
        ["review", "--source", "narnia"],
      ]) {
        harness.err.length = 0;
        strictEqual(await run(["--corpus", harness.corpus, ...argv], harness.deps), EXIT_USAGE, argv.join(" "));
        match(harness.stderr(), /Unknown parliament "narnia"\. Known: .*berlin/);
      }
      // A key in the wrong case is still that key.
      harness.out.length = 0;
      strictEqual(await run(["--corpus", harness.corpus, "search", "--parliament", "Berlin", "solaranlagen"], harness.deps), EXIT_OK);
      match(harness.stdout(), /berlin-19-10006/);
    } finally {
      harness.cleanup();
    }
  });

  it("calls a malformed record id a usage error, before the store is asked", async () => {
    // It surfaced from the store as exit 3, "the corpus is missing or unreadable",
    // which says nothing about the id. The store still refuses it on its own.
    const harness = cliHarness();
    try {
      for (const argv of [
        ["show", "../etc/passwd"],
        ["get", "BERLIN-19-10006"],
        ["open", "a/../b"],
        ["verify", "Berlin-19-10006"],
        ["review", "--mark-verified", "../x"],
      ]) {
        harness.err.length = 0;
        strictEqual(await run(["--corpus", harness.corpus, ...argv], harness.deps), EXIT_USAGE, argv.join(" "));
        match(harness.stderr(), /Not a record id/);
      }
    } finally {
      harness.cleanup();
    }
  });

  it("reports a corpus that is not there with its own exit code, not as an empty result", async () => {
    // A mistyped --corpus answered "No matches." and "0 record(s)" with exit 0.
    const harness = cliHarness();
    try {
      const missing = join(harness.corpus, "typo");
      for (const argv of [["search", "brücke"], ["stats"], ["get", "berlin-19-1"], ["export", "--format", "jsonl"], ["verify", "--all"], ["reindex"]]) {
        harness.err.length = 0;
        strictEqual(await run(["--corpus", missing, ...argv], harness.deps), EXIT_STORE, argv.join(" "));
        match(harness.stderr(), /No corpus at .*typo: nothing has been synced there/);
      }
      ok(!existsSync(missing), "a read command must not create the corpus");
      // Commands that do not read a corpus still work without one.
      strictEqual(await run(["--corpus", missing, "sources", "list"], harness.deps), EXIT_OK);
      strictEqual(await run(["--corpus", missing, "schema"], harness.deps), EXIT_OK);
    } finally {
      harness.cleanup();
    }
  });
});

describe("ka-factory", () => {
  it("prints help and exits 0", async () => {
    const harness = cliHarness();
    strictEqual(await runFactory(["--help"], harness.deps), EXIT_OK);
    match(harness.stdout(), /Usage: ka-factory/);
    harness.cleanup();
  });

  it("passes the guardrail lint on this repository", async () => {
    const harness = cliHarness();
    strictEqual(await runFactory(["lint"], harness.deps), EXIT_OK);
    // A root with no packages under it is an error, not a clean scan of nothing.
    strictEqual(await runFactory(["lint", "--root", harness.corpus], harness.deps), EXIT_ERROR);
    match(harness.stderr(), /nothing to lint/);
    match(harness.stdout(), /No generative-model dependency on the line/);
    harness.cleanup();
  });

  it("renders a record for reading, sanitising every upstream field", () => {
    // Now assertable directly; it used to be 55 lines of `io.out` calls inside a
    // registration closure, reachable only by driving the whole CLI.
    const lines = renderShowLines(
      sampleRecord({
        title: "Titel\u009b31m",
        source_documents: [{ role: "answer_pdf", url: "https://x.invalid/a.pdf\u009b31m", url_stable: false }],
      }),
    );
    ok(lines.some((line) => line.startsWith("Abgeordnetenhaus von Berlin · Drucksache 19/12345")));
    ok(lines.some((line) => line.includes("(link expires upstream)")));
    strictEqual(
      lines.some((line) => [...line].some((ch) => {
        const code = ch.codePointAt(0) ?? 0;
        return code < 0x20 || (code >= 0x7f && code <= 0x9f);
      })),
      false,
    );
  });

  it("says so rather than printing a blank when nothing was extracted", () => {
    const lines = renderShowLines(sampleRecord({ qa: [] }));
    ok(lines.includes("(no question/answer pairs were extracted)"));
  });

  it("sanitises an error message, which routinely quotes upstream data", async () => {
    const harness = cliHarness();
    // A record id is echoed back in the "no such record" message.
    await run(["get", "nosuch\u009b31m", "--corpus", harness.corpus], harness.deps);
    const stderr = harness.stderr();
    strictEqual(
      [...stderr].some((ch) => {
        const code = ch.codePointAt(0) ?? 0;
        return (code < 0x20 && code !== 0x0a) || (code >= 0x7f && code <= 0x9f);
      }),
      false,
      stderr,
    );
  });

  it("refuses a query with no searchable terms rather than matching everything", async () => {
    const harness = cliHarness();
    for (const query of ["--- ... ???", "a"]) {
      strictEqual(await run(["search", query, "--corpus", harness.corpus], harness.deps), EXIT_USAGE, query);
    }
    match(harness.stderr(), /Nothing searchable/);
    // An explicitly empty query still means "everything that passes the filters".
    strictEqual(await run(["search", "", "--corpus", harness.corpus], harness.deps), EXIT_OK);
  });

  it("refuses --like combined with options it cannot honour", async () => {
    // Accepting them and quietly dropping them is the silently-ignored constraint
    // this CLI refuses everywhere else.
    const harness = cliHarness();
    for (const argv of [
      ["search", "solaranlagen", "--like", "berlin-19-10006"],
      ["search", "--like", "berlin-19-10006", "--offset", "5"],
      ["search", "--like", "berlin-19-10006", "--snippet"],
    ]) {
      strictEqual(await run([...argv, "--corpus", harness.corpus], harness.deps), EXIT_USAGE, argv.join(" "));
    }
    match(harness.stderr(), /--like cannot be combined with/);
  });

  it("refuses a --baseline path that is not there", async () => {
    // A missing default baseline means "first run"; a missing path the caller
    // named is a typo, and it used to answer one with "every source is new,
    // nothing is wrong" and exit 0.
    const harness = cliHarness();
    strictEqual(
      await runFactory(["drift", "--baseline", "/nonexistent/baseline.json", "--corpus", harness.corpus], harness.deps),
      EXIT_ERROR,
    );
    match(harness.stderr(), /No baseline at/);
  });

  it("verifies the committed goldens", async () => {
    const harness = cliHarness();
    strictEqual(await runFactory(["goldens", "verify"], harness.deps), EXIT_OK);
    match(harness.stdout(), /(\d+)\/\1 golden\(s\) reproduced/);
    harness.cleanup();
  });

  it("lists the goldens with their notes", async () => {
    const harness = cliHarness();
    strictEqual(await runFactory(["goldens", "list"], harness.deps), EXIT_OK);
    match(harness.stdout(), /berlin-19-10006/);
    harness.cleanup();
  });

  it("measures health, builds embeddings and then finds similar records", async () => {
    const harness = await seeded();
    try {
      strictEqual(await runFactory(["--corpus", harness.corpus, "health"], harness.deps), EXIT_OK);
      match(harness.stdout(), /berlin: \d+ record\(s\)/);

      harness.out.length = 0;
      strictEqual(await runFactory(["--corpus", harness.corpus, "embed"], harness.deps), EXIT_OK);
      match(harness.stdout(), /hashed-tfidf-v1/);

      harness.out.length = 0;
      strictEqual(await run(["--corpus", harness.corpus, "search", "--like", "berlin-19-10006"], harness.deps), EXIT_OK);
    } finally {
      harness.cleanup();
    }
  });

  it("reports drift against a saved baseline", async () => {
    const harness = await seeded();
    try {
      const baseline = `${harness.corpus}/baseline.json`;
      strictEqual(await runFactory(["--corpus", harness.corpus, "health", "--save-baseline", baseline], harness.deps), EXIT_OK);
      harness.out.length = 0;
      strictEqual(await runFactory(["--corpus", harness.corpus, "drift", "--baseline", baseline], harness.deps), EXIT_OK);
      match(harness.stdout(), /No drift against the baseline/);
    } finally {
      harness.cleanup();
    }
  });

  it("keeps the default baseline in the corpus it measures, wherever the command runs", async () => {
    // The default was fixtures/health-baseline.json under the cwd, which nothing
    // created: the documented command failed with a raw ENOENT.
    const harness = await seeded();
    try {
      strictEqual(await runFactory(["--corpus", harness.corpus, "health", "--save-baseline"], harness.deps), EXIT_OK);
      ok(existsSync(join(harness.corpus, "health-baseline.json")));
      harness.out.length = 0;
      harness.err.length = 0;
      strictEqual(await runFactory(["--corpus", harness.corpus, "drift", "--fail-on-drift"], harness.deps), EXIT_OK);
      match(harness.stdout(), /No drift against the baseline/);
      // A path whose directory does not exist yet is created.
      const nested = join(harness.corpus, "reports", "2026", "baseline.json");
      strictEqual(await runFactory(["--corpus", harness.corpus, "health", "--save-baseline", nested], harness.deps), EXIT_OK);
      ok(existsSync(nested));
      // A blank path is a usage error, not EISDIR on the cwd.
      strictEqual(await runFactory(["--corpus", harness.corpus, "health", "--save-baseline", ""], harness.deps), EXIT_USAGE);
      // A path that cannot be written is an error that says so.
      harness.err.length = 0;
      writeFileSync(join(harness.corpus, "afile"), "x");
      strictEqual(
        await runFactory(["--corpus", harness.corpus, "health", "--save-baseline", join(harness.corpus, "afile", "b.json")], harness.deps),
        EXIT_ERROR,
      );
      match(harness.stderr(), /Could not write the baseline/);
      doesNotMatch(harness.stderr(), /Unexpected error/);
    } finally {
      harness.cleanup();
    }
  });

  it("reports a corpus with no baseline as new rather than broken", async () => {
    // The *default* baseline being absent means "first run", which is not an
    // error. A baseline the caller named and got wrong is — see the test below.
    const harness = await seeded();
    try {
      strictEqual(await runFactory(["--corpus", harness.corpus, "drift"], harness.deps), EXIT_OK);
      match(harness.stdout(), /\[new_source\]/);
      match(harness.stderr(), /No baseline at/);
    } finally {
      harness.cleanup();
    }
  });

  it("keeps the two binaries' exit codes consistent", async () => {
    const harness = cliHarness();
    strictEqual(await runFactory(["nonsense"], harness.deps), EXIT_USAGE);
    harness.cleanup();
  });
});

describe("--out", () => {
  it("means stdout for -, and does not replace a file without --force", async () => {
    // `--out -` wrote a file named "-", and `-o keep.txt` replaced its content silently.
    const harness = await seeded();
    try {
      strictEqual(await run(["--corpus", harness.corpus, "get", "berlin-19-10006", "--out", "-"], harness.deps), EXIT_OK);
      match(harness.stdout(), /"id": "berlin-19-10006"/);
      strictEqual(harness.files.size, 0);

      harness.files.set("keep.txt", Buffer.from("precious"));
      harness.err.length = 0;
      strictEqual(await run(["--corpus", harness.corpus, "get", "berlin-19-10006", "-o", "keep.txt"], harness.deps), EXIT_USAGE);
      match(harness.stderr(), /Refusing to overwrite existing file keep\.txt; pass --force/);
      strictEqual(harness.files.get("keep.txt")?.toString(), "precious");
      strictEqual(await run(["--corpus", harness.corpus, "export", "--format", "csv", "-o", "keep.txt"], harness.deps), EXIT_USAGE);
      strictEqual(await run(["--corpus", harness.corpus, "feed", "-o", "keep.txt"], harness.deps), EXIT_USAGE);
      strictEqual(harness.files.get("keep.txt")?.toString(), "precious");

      strictEqual(await run(["--corpus", harness.corpus, "get", "berlin-19-10006", "-o", "keep.txt", "--force"], harness.deps), EXIT_OK);
      match(harness.files.get("keep.txt")?.toString() ?? "", /"id": "berlin-19-10006"/);

      harness.err.length = 0;
      strictEqual(await run(["--corpus", harness.corpus, "export", "--format", "csv", "--force"], harness.deps), EXIT_USAGE);
      match(harness.stderr(), /--force needs --out/);
    } finally {
      harness.cleanup();
    }
  });

  it("creates the file exclusively on disk unless told to overwrite", () => {
    const dir = mkdtempSync(join(tmpdir(), "openka-out-"));
    try {
      const path = join(dir, "keep.txt");
      defaultIO.writeFile(path, Buffer.from("precious"));
      throws(() => defaultIO.writeFile(path, Buffer.from("new")), /EEXIST/);
      strictEqual(readFileSync(path, "utf8"), "precious");
      defaultIO.writeFile(path, Buffer.from("new"), { overwrite: true });
      strictEqual(readFileSync(path, "utf8"), "new");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("says a directory is not a file, whether or not --force is given", async () => {
    const harness = await seeded();
    const dir = mkdtempSync(join(tmpdir(), "openka-out-"));
    try {
      const deps = { ...harness.deps, io: { ...harness.deps.io, writeFile: defaultIO.writeFile } };
      for (const extra of [[], ["--force"]]) {
        harness.err.length = 0;
        strictEqual(await run(["--corpus", harness.corpus, "get", "berlin-19-10006", "-o", dir, ...extra], deps), EXIT_ERROR);
        match(harness.stderr(), /is a directory; give a file path to --out/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      harness.cleanup();
    }
  });
});

describe("the harness itself", () => {
  it("captures stdout, stderr and written files", () => {
    const harness = cliHarness();
    harness.deps.io.out("a");
    harness.deps.io.err("b");
    harness.deps.io.writeFile("/tmp/x", Buffer.from("c"));
    deepStrictEqual(harness.out, ["a"]);
    deepStrictEqual(harness.err, ["b"]);
    strictEqual(harness.files.get("/tmp/x")?.toString(), "c");
    harness.cleanup();
  });
});

// P7 of the 2026-10-05 fix plan, adapted: the sibling repos spawn the bin, but no
// test here spawns a subprocess, so the handler is driven with fake streams and
// the bins are checked to install it before they run anything.
// Finding 04#4: the help named two of the three steps of the corpus default.
describe("the --corpus help", () => {
  it("names the whole default, in the order it is applied, in both bins", async () => {
    for (const [runner, argv] of [
      [run, ["--help"]],
      [runFactory, ["--help"]],
    ] as const) {
      const harness = cliHarness();
      try {
        strictEqual(await runner([...argv], harness.deps), EXIT_OK);
        match(harness.stdout().replace(/\s+/g, " "), /\$OPENKA_CORPUS, else \$XDG_DATA_HOME\/openka, else ~\/\.local\/share\/openka/);
      } finally {
        harness.cleanup();
      }
    }
  });
});

describe("a closed output pipe", () => {
  function fakeStreams(): { stdout: EventEmitter; stderr: EventEmitter; exits: number[]; exit: (code: number) => void } {
    const exits: number[] = [];
    return { stdout: new EventEmitter(), stderr: new EventEmitter(), exits, exit: (code) => void exits.push(code) };
  }
  const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });

  it("exits 0 quietly when stdout's reader stops early (`ka export | head`)", () => {
    const streams = fakeStreams();
    handleOutputErrors(streams as never, streams.exit);
    streams.stdout.emit("error", epipe);
    deepStrictEqual(streams.exits, [0]);
  });

  it("keeps a failed run's exit code when stderr's reader is gone", () => {
    const streams = fakeStreams();
    handleOutputErrors(streams as never, streams.exit);
    streams.stderr.emit("error", epipe);
    deepStrictEqual(streams.exits, []);
  });

  it("treats ENOTCONN (stdout a socket whose reader has gone) like EPIPE on both streams", () => {
    const streams = fakeStreams();
    handleOutputErrors(streams as never, streams.exit);
    const enotconn = Object.assign(new Error("write ENOTCONN"), { code: "ENOTCONN" });
    streams.stderr.emit("error", enotconn);
    deepStrictEqual(streams.exits, []);
    streams.stdout.emit("error", enotconn);
    deepStrictEqual(streams.exits, [0]);
  });

  it("exits 1 on any other output error", () => {
    const streams = fakeStreams();
    handleOutputErrors(streams as never, streams.exit);
    streams.stderr.emit("error", Object.assign(new Error("EIO"), { code: "EIO" }));
    deepStrictEqual(streams.exits, [1]);
  });

  it("is installed by both bins before they run a command", () => {
    for (const bin of [
      fileURLToPath(new URL("../src/index.js", import.meta.url)),
      fileURLToPath(new URL("../../../cli-ka-factory/dist/src/cli/index.js", import.meta.url)),
    ]) {
      const text = readFileSync(bin, "utf8");
      const installed = text.indexOf("handleOutputErrors()");
      ok(installed > 0, `${bin} does not install handleOutputErrors`);
      ok(installed < text.search(/await run(?:Factory)?\(/), `${bin} runs before it installs the handler`);
    }
  });
});
