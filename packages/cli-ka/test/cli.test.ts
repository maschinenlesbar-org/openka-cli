// The CLI, driven in-process through `run()` with a real temporary corpus, a
// scripted transport and a fixed clock. No subprocess, no network.

import { deepStrictEqual, doesNotMatch, match, ok, rejects, strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT_ERROR, EXIT_OK, EXIT_STORE, EXIT_USAGE, EXIT_VERSION_ONLY, run } from "../src/run.js";
import type { KaRecord } from "@maschinenlesbar.org/openka-lib-models";
import type { Transport } from "@maschinenlesbar.org/openka-lib-http";
import { runFactory } from "@maschinenlesbar.org/openka-cli-ka-factory";
import { parseIsoDate, parseBoundedInt, parseNonEmpty } from "../src/shared.js";
import { CredentialStore, FileStore, RunStatusRecorder, indexRecord, resolveCorpusRoot, toCatalogEntry, type FilesystemInfo, type VolumeProbe } from "@maschinenlesbar.org/openka-lib-store";
import { hostname, tmpdir } from "node:os";
import { escapeControlChars, sanitizeForTerminal, truncate } from "../src/text.js";
import { formatHit, renderShowLines } from "../src/commands/query.js";
import { sampleRecord, scriptedTransport, fixturesOf } from "@maschinenlesbar.org/openka-lib-testing";
import { cliHarness } from "./harness.js";
import { InterruptedRunError, defaultIO, handleOutputErrors, readSecretFrom } from "../src/io.js";
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

/** A volume of this filesystem with `free` bytes free, wherever the path. */
function volumesOf(filesystem: FilesystemInfo, free: number): VolumeProbe {
  return { space: () => ({ free, total: 64e9 }), filesystem: () => filesystem };
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

describe("ka sync --ref, --retry-failed and --only-new (issue #27)", () => {
  it("handles only what is asked for, and asks nothing about the rest", async () => {
    const { transport, requests } = berlinTransport();
    const harness = cliHarness({ transport });
    try {
      strictEqual(await run(["--corpus", harness.corpus, "sync", "--source", "berlin"], harness.deps), EXIT_OK, harness.stderr());
      const pdfs = (): number => requests.filter((request) => request.url.endsWith(".pdf")).length;
      const before = pdfs();
      harness.out.length = 0;
      strictEqual(await run(["--corpus", harness.corpus, "sync", "--source", "berlin", "--only-new", "--json"], harness.deps), EXIT_OK, harness.stderr());
      const report = JSON.parse(harness.stdout()) as { discovered: number; skipped: number; stored: number; unchanged: number };
      strictEqual(report.skipped, report.discovered);
      deepStrictEqual([report.stored, report.unchanged, pdfs()], [0, 0, before]);

      harness.out.length = 0;
      strictEqual(await run(["--corpus", harness.corpus, "sync", "--source", "berlin", "--ref", "19/10006", "--ref", "19/77777"], harness.deps), EXIT_OK, harness.stderr());
      match(harness.stdout(), /^berlin: \d+ discovered, \d+ not selected, 0 stored, 1 unchanged, 0 failed$/m);
      match(harness.stderr(), /--ref: not in this window, so not synced: 19\/77777/);

      harness.out.length = 0;
      strictEqual(await run(["--corpus", harness.corpus, "sync", "--source", "berlin", "--ref", "19/10006", "--dry-run"], harness.deps), EXIT_OK, harness.stderr());
      match(harness.stdout(), /^berlin ref 19\/10006: \d+ Anfragen discovered, \d+ already in corpus, 1 selected$/m);
    } finally {
      harness.cleanup();
    }
  });

  it("refuses a blank reference, and the selection flags beside --plan", async () => {
    const harness = cliHarness();
    try {
      strictEqual(await run(["--corpus", harness.corpus, "sync", "--source", "berlin", "--ref", " "], harness.deps), EXIT_USAGE);
      strictEqual(await run(["--corpus", harness.corpus, "sync", "--plan", "jobs.toml", "--only-new"], harness.deps), EXIT_USAGE);
      match(harness.stderr(), /put --only-new in the plan/);
    } finally {
      harness.cleanup();
    }
  });
});

describe("a record an earlier build filed under another paper's id (issue #25)", () => {
  it("is a problem for ka doctor, and ka reextract moves it", async () => {
    const harness = await seeded();
    try {
      const corpus = ["--corpus", harness.corpus];
      const store = new FileStore(harness.corpus);
      const record = sampleRecord({ id: "sachsen-anhalt-8-1487", parliament: "sachsen-anhalt", reference: "08/1487", legislative_period: 8, document_type: "kleine_anfrage", dates: { submitted: "2023-05-19" }, source_documents: [] });
      store.putRecord(record);
      indexRecord(store, record);

      strictEqual(await run([...corpus, "doctor"], harness.deps), EXIT_STORE);
      match(harness.stderr(), /ERROR \[ka\.doctor\] 1 record\(s\) hold the id of another paper/);
      harness.out.length = 0;
      strictEqual(await run([...corpus, "reextract", "--parliament", "sachsen-anhalt"], harness.deps), EXIT_OK, harness.stderr());
      match(harness.stdout(), /^MOVED sachsen-anhalt-8-1487 → sachsen-anhalt-8-ka-1487: an earlier build gave it the id of another paper$/m);
      match(harness.stdout(), /^1 record\(s\) moved to the id this build gives them/m);
      harness.err.length = 0;
      strictEqual(await run([...corpus, "doctor"], harness.deps), EXIT_OK, harness.stderr());
    } finally {
      harness.cleanup();
    }
  });
});

describe("ka reextract's Q/A comparison (issue #26)", () => {
  it("counts pairs, questions and answers per record, and names the records that read fewer", async () => {
    const harness = await seeded();
    try {
      const store = new FileStore(harness.corpus);
      const stored = store.getRecord("berlin-19-10006") as KaRecord;
      // As if an older build had read one answer more.
      store.putRecord({ ...stored, qa: [...stored.qa, { number: "99", question: "Noch eine?", answer: "Ja." }], extraction: { ...stored.extraction, extractor_version: "pkg:0.6.0+extract:0992e8afa678" } });
      strictEqual(await run(["--corpus", harness.corpus, "reextract", "berlin-19-10006"], harness.deps), EXIT_OK, harness.stderr());
      match(harness.stdout(), /^ {2}Q\/A: 7 → 6 pairs, 7 → 6 questions, 7 → 6 answers$/m);
      match(harness.stdout(), /^ {2}no longer read, by number: 99, 99\.question, 99\.answer$/m);
      match(harness.stdout(), /^1 record\(s\) read fewer answers or questions than before: berlin-19-10006$/m);
    } finally {
      harness.cleanup();
    }
  });
});

describe("ka rm (issue #28)", () => {
  it("removes records under the lock, says which, and keeps a document other records share", async () => {
    const harness = await seeded();
    try {
      const corpus = ["--corpus", harness.corpus];
      strictEqual(await run([...corpus, "rm", "berlin-19-10006", "--documents", "--dry-run"], harness.deps), EXIT_OK, harness.stderr());
      match(harness.stdout(), /^would remove berlin-19-10006$/m);
      match(harness.stdout(), /Nothing was changed \(--dry-run\)\./);
      harness.out.length = 0;
      strictEqual(await run([...corpus, "rm", "berlin-19-10006", "--documents"], harness.deps), EXIT_OK, harness.stderr());
      match(harness.stdout(), /^removed berlin-19-10006$/m);
      match(harness.stdout(), /^Removed 1 record\(s\); 1 document\(s\) kept, since records that stay refer to them\.$/m);
      strictEqual(await run([...corpus, "get", "berlin-19-10006"], harness.deps), EXIT_ERROR);
      harness.out.length = 0;
      strictEqual(await run([...corpus, "rm", "--orphaned-documents", "--json", "--dry-run"], harness.deps), EXIT_OK, harness.stderr());
      deepStrictEqual((JSON.parse(harness.stdout()) as { blobs_removed: string[] }).blobs_removed, []);
      harness.out.length = 0;
      strictEqual(await run([...corpus, "doctor", "--orphaned-documents"], harness.deps), EXIT_OK, harness.stderr());
      match(harness.stdout(), /^documents +every archived document belongs to a record$/m);
    } finally {
      harness.cleanup();
    }
  });

  it("refuses to guess what to remove", async () => {
    const harness = await seeded();
    try {
      const corpus = ["--corpus", harness.corpus];
      strictEqual(await run([...corpus, "rm"], harness.deps), EXIT_USAGE);
      strictEqual(await run([...corpus, "rm", "berlin-19-10006", "--parliament", "berlin"], harness.deps), EXIT_USAGE);
      strictEqual(await run([...corpus, "rm", "--orphaned-documents", "berlin-19-10006"], harness.deps), EXIT_USAGE);
      strictEqual(await run([...corpus, "rm", "berlin-19-99999", "berlin-19-10006"], harness.deps), EXIT_ERROR);
      match(harness.stderr(), /No record berlin-19-99999 in the corpus; nothing was removed/);
      harness.out.length = 0;
      strictEqual(await run([...corpus, "rm", "--parliament", "bayern"], harness.deps), EXIT_OK);
      match(harness.stdout(), /No record matches the filters; nothing was removed\./);
    } finally {
      harness.cleanup();
    }
  });
});

describe("a source blocked by robots.txt", () => {
  // A daily `ka sync --source sachsen-anhalt` could not tell "blocked" from "nothing
  // new": both printed "0 discovered", exited 0, and stamped the source as synced.
  it("says blocked, puts it in --json, and is not recorded as a sync", async () => {
    const harness = cliHarness({
      transport: scriptedTransport([{ match: "robots.txt", body: "User-agent: *\nDisallow: /\n" }]).transport,
    });
    try {
      strictEqual(await run(["--corpus", harness.corpus, "sync", "--source", "sachsen-anhalt"], harness.deps), EXIT_OK);
      match(harness.stdout(), /^sachsen-anhalt: blocked — nothing was looked at/m);
      doesNotMatch(harness.stdout(), /0 discovered/);
      harness.out.length = 0;
      strictEqual(await run(["--corpus", harness.corpus, "sync", "--source", "sachsen-anhalt", "--json"], harness.deps), EXIT_OK);
      const report = JSON.parse(harness.stdout()) as { blocked?: string };
      ok(report.blocked?.includes("robots.txt"));
      harness.out.length = 0;
      strictEqual(await run(["--corpus", harness.corpus, "sources", "list"], harness.deps), EXIT_OK);
      match(harness.stdout(), /^sachsen-anhalt\s+\S+\s+0\s+never$/m);
    } finally {
      harness.cleanup();
    }
  });
});

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
    match(harness.stdout(), /credential: --api-key, DIP_API_KEY or `ka config set bund\.api-key`/);
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

  it("prints no bidi override from `get --format md`, as `show` does not", async () => {
    const harness = await seeded();
    try {
      const store = harness.deps.createStore(harness.corpus);
      const record = store.getRecord("berlin-19-10006");
      ok(record !== undefined);
      record.title = "Titel \u202eesrever\u202c";
      store.putRecord(record);
      strictEqual(await run(["--corpus", harness.corpus, "get", "berlin-19-10006", "--format", "md"], harness.deps), EXIT_OK);
      match(harness.stdout(), /^# Titel esrever$/m);
      doesNotMatch(harness.stdout(), /[\u202a-\u202e]/);
    } finally {
      harness.cleanup();
    }
  });

  it("verifies a synced record byte for byte", async () => {
    const harness = await seeded();
    try {
      strictEqual(await run(["--corpus", harness.corpus, "verify", "berlin-19-10006"], harness.deps), EXIT_OK);
      match(harness.stdout(), /1\/1 record\(s\) reproduced byte-identically/);
      // …and says what that does not cover: the metadata re-extraction takes
      // from the record itself.
      match(harness.stderr(), /^INFO  \[ka\.verify\] verify re-derives .* Title, askers, answered_by, dates and the documents' URLs come from the record itself and are not checked against anything archived\.$/m);
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
          match(harness.stderr(), /^INFO  \[ka\.store\] ignored 2 macOS AppleDouble\/\.DS_Store file\(s\) in the corpus; `ka doctor --fix` or `dot_clean .*` removes them\.$/m);
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
        // With the harness's frozen clock there is no rate; the timing still follows.
        const progress = /^INFO  \[ka\.sync\] berlin: \d+ Anfragen discovered$[\s\S]*^INFO  \[ka\.sync\] berlin: (\d+)\/\1 · 0 failed · upstream [\d.]+ s\/req/m;
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
      match(harness.stderr(), /^INFO  \[ka\.sync\] skipped bund: it needs a credential \(--api-key, DIP_API_KEY or `ka config set bund\.api-key`\)\.$/m);
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
      match(harness.stderr(), /^INFO  \[ka\.store\] Waiting for the corpus: it is in use by another run \(sync --source bund, pid \d+/m);
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

  it("says what the corpus takes on disk, and leaves it out with --no-disk", async () => {
    const harness = await seeded();
    try {
      for (const argv of [["stats"], ["stats", "--disk"]]) {
        harness.out.length = 0;
        strictEqual(await run(["--corpus", harness.corpus, ...argv], harness.deps), EXIT_OK);
        match(harness.stdout(), /^On disk: blobs \d+ KB in 1 file\(s\), records [\d.]+ KB in \d+ file\(s\), index [\d.]+ KB in \d+ file\(s\); [\d.]+ KB in all, [\d.]+ KB per Anfrage$/m);
        match(harness.stdout(), /^ {2}berlin: 1 document\(s\), \d+ KB \(avg \d+ KB\)$/m);
      }
      harness.out.length = 0;
      strictEqual(await run(["--corpus", harness.corpus, "stats", "--json", "--no-disk"], harness.deps), EXIT_OK);
      ok(!("disk" in (JSON.parse(harness.stdout()) as object)), "listing every file costs a stat each, so it can be left out");
    } finally {
      harness.cleanup();
    }
  });

  it("counts each upstream beside the corpus with sources count", async () => {
    const countPage = '<b>69.935</b> <span>Vorgänge</span>';
    const { transport, requests } = scriptedTransport([
      { match: "parlamentsspiegel.de/suche", body: countPage },
      { match: "/api/v1/vorgang", body: '{"numFound":39124}' },
      { match: "/api/v1/drucksache", body: '{"numFound":2747}' },
    ]);
    const harness = cliHarness({ transport, env: { DIP_API_KEY: "test-key" } });
    try {
      strictEqual(await run(["--corpus", harness.corpus, "sources", "count", "--source", "bund", "--source", "berlin"], harness.deps), EXIT_OK, harness.stderr());
      match(harness.stdout(), /^SOURCE +UPSTREAM +IN CORPUS +MISSING +BASIS$/m);
      match(harness.stdout(), /^bund +41,871 +0 +41,871 +DIP numFound \(Drucksachen to WP 7, Vorgänge from WP 8\)$/m);
      match(harness.stdout(), /^berlin +69,935 +0 +69,935 +Parlamentsspiegel$/m);
      match(harness.stdout(), /^total +111,806 +0 +111,806$/m);
      strictEqual(requests.length, 3, "a request or two per source, no download");

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
        match(harness.stderr(), /^ERROR \[ka\.store\] blob store .* is not available/m, argv.join(" "));
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
      match(harness.stderr(), /^WARN  \[ka\.store\] .* is on a volume without extended attributes \(FAT32 or exFAT\).*65,534 entries/m);
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

  it("refuses to sync onto FAT32 or exFAT before writing anything, unless --allow-fs", async () => {
    for (const [name, kind] of [["msdos", "fat32"], ["exfat", "exfat"]] as const) {
      const { transport, requests } = berlinTransport();
      const harness = cliHarness({ transport, volumes: volumesOf({ name, kind }, 100e9) });
      try {
        strictEqual(await run(["--corpus", harness.corpus, "sync", "--source", "berlin"], harness.deps), EXIT_STORE, kind);
        match(harness.stderr(), new RegExp(`^ERROR \\[ka\\.store\\] the corpus .* is on (FAT32|exFAT) \\(${name}\\).*--allow-fs ${kind} to use it anyway\\. Nothing was synced\\.$`, "m"));
        strictEqual(requests.length, 0);
        deepStrictEqual(readdirSync(harness.corpus), [], "not even the lock file");

        strictEqual(await run(["--corpus", harness.corpus, "sync", "--source", "berlin", "--allow-fs", kind], harness.deps), EXIT_OK, harness.stderr());
        match(harness.stdout(), /^berlin: \d+ discovered, \d+ stored/m);
      } finally {
        harness.cleanup();
      }
    }
  });

  it("refuses to sync with less free space than --min-free, and warns on a network filesystem", async () => {
    const harness = cliHarness({ transport: berlinTransport().transport, volumes: volumesOf({ name: "smbfs", kind: "network" }, 800e6) });
    try {
      strictEqual(await run(["--corpus", harness.corpus, "sync", "--source", "berlin"], harness.deps), EXIT_STORE);
      match(harness.stderr(), /^ERROR \[ka\.store\] only 800 MB free for the corpus .*, less than the 1\.0 GB to keep \(--min-free\)\. Nothing was synced\.$/m);
      strictEqual(await run(["--corpus", harness.corpus, "sync", "--source", "berlin", "--min-free", "500M"], harness.deps), EXIT_OK, harness.stderr());
      match(harness.stderr(), /^WARN  \[ka\.store\] the corpus .* is on a network filesystem \(smbfs\)/m);
      for (const bad of ["lots", "-1", ""]) {
        strictEqual(await run(["--corpus", harness.corpus, "sync", "--source", "berlin", "--min-free", bad], harness.deps), EXIT_USAGE, bad);
      }
      strictEqual(await run(["--corpus", harness.corpus, "sync", "--source", "berlin", "--allow-fs", "ntfs"], harness.deps), EXIT_USAGE);
      match(harness.stderr(), /Allowed choices are fat32, exfat\./);
    } finally {
      harness.cleanup();
    }
  });

  it("stops a sync whose disk runs low, keeps what it stored, and exits 3", async () => {
    let asked = 0;
    const draining: VolumeProbe = {
      // The preflight asks once, then the run before each Anfrage: low from the second.
      space: () => ({ free: ++asked > 2 ? 200e6 : 100e9, total: 500e9 }),
      filesystem: () => ({ name: "apfs", kind: "local" }),
    };
    const harness = cliHarness({ transport: berlinTransport().transport, volumes: draining });
    try {
      strictEqual(await run(["--corpus", harness.corpus, "sync", "--source", "berlin"], harness.deps), EXIT_STORE);
      match(harness.stdout(), /^berlin: \d+ discovered, 1 stored, 0 unchanged, 0 failed$/m);
      match(harness.stderr(), /^ERROR \[ka\.store\] berlin: stopped after 1 of \d+ Anfragen — only 200 MB free for the corpus .*; what was stored is catalogued\. Free some space, then run the same sync again to continue\.$/m);
      strictEqual(new FileStore(harness.corpus).catalog().length, 1);
      ok(!existsSync(join(harness.corpus, "lock")));
    } finally {
      harness.cleanup();
    }
  });

  it("says in --dry-run whether the download fits and what a sync would refuse", async () => {
    const responses = (): ReturnType<typeof scriptedTransport> =>
      scriptedTransport([
        { match: "pardok-wp19.xml", body: PARDOK },
        { match: "robots.txt", status: 404 },
        { match: ".pdf", headers: { "content-length": "110000" } },
      ]);
    const roomy = cliHarness({ transport: responses().transport });
    try {
      strictEqual(await run(["--corpus", roomy.corpus, "sync", "--source", "berlin", "--dry-run"], roomy.deps), EXIT_OK, roomy.stderr());
      match(roomy.stdout(), /^space: ≈ [\d.]+ (KB|MB) to fetch, 500 GB free for .*$/m);
    } finally {
      roomy.cleanup();
    }
    const tight = cliHarness({ transport: responses().transport, volumes: volumesOf({ name: "msdos", kind: "fat32" }, 1.0001e9) });
    try {
      strictEqual(await run(["--corpus", tight.corpus, "sync", "--source", "berlin", "--dry-run"], tight.deps), EXIT_OK, tight.stderr());
      match(tight.stderr(), /^WARN  \[ka\.store\] a sync would refuse: the corpus .* is on FAT32 \(msdos\)/m);
      match(tight.stderr(), /^WARN  \[ka\.store\] the documents to fetch \(≈ [\d.]+ (KB|MB)\) do not fit: 1\.0 GB is free for the corpus .*, and 1\.0 GB of it is to be kept \(--min-free\)$/m);
      doesNotMatch(tight.stdout(), /^space:/m);
    } finally {
      tight.cleanup();
    }
  });

  it("checks the corpus with ka doctor, and exits 3 on a problem", async () => {
    const harness = await seeded();
    try {
      strictEqual(await run(["--corpus", harness.corpus, "doctor"], harness.deps), EXIT_OK, harness.stderr());
      match(harness.stdout(), /^corpus +\S+$/m);
      match(harness.stdout(), /^ {2}filesystem +apfs \(local\)$/m);
      match(harness.stdout(), /^ {2}free +500 GB of 1\.0 TB$/m);
      match(harness.stdout(), /^blobs +in the corpus$/m);
      match(harness.stdout(), /^lock +free$/m);
      match(harness.stdout(), /^catalog +\d+ record\(s\), all catalogued$/m);
      match(harness.stdout(), /^No problems found\.$/m);

      harness.out.length = 0;
      strictEqual(await run(["--corpus", harness.corpus, "doctor", "--json"], harness.deps), EXIT_OK);
      const diagnosis = JSON.parse(harness.stdout()) as { exists: boolean; lock: { state: string }; problems: string[]; volumes: { role: string }[] };
      deepStrictEqual([diagnosis.exists, diagnosis.lock.state, diagnosis.problems, diagnosis.volumes.map((volume) => volume.role)], [true, "free", [], ["corpus"]]);

      // The doctor's verdict is the one sync would reach with the same flags.
      harness.out.length = 0;
      harness.err.length = 0;
      harness.deps.volumes = volumesOf({ name: "msdos", kind: "fat32" }, 100e9);
      strictEqual(await run(["--corpus", harness.corpus, "doctor"], harness.deps), EXIT_STORE);
      match(harness.stderr(), /^ERROR \[ka\.doctor\] the corpus .* is on FAT32 \(msdos\)/m);
      match(harness.stderr(), /^ERROR \[ka\.store\] 1 problem\(s\) with the corpus at /m);
      strictEqual(await run(["--corpus", harness.corpus, "doctor", "--allow-fs", "fat32"], harness.deps), EXIT_OK);
    } finally {
      harness.cleanup();
    }
  });

  it("counts the macOS files with ka doctor and removes them with --fix", async () => {
    const harness = await seeded();
    try {
      writeFileSync(join(harness.corpus, "records", "._berlin-19-10006.json"), "\0\u0005\u0016\u0007");
      writeFileSync(join(harness.corpus, ".DS_Store"), "");
      strictEqual(await run(["--corpus", harness.corpus, "doctor"], harness.deps), EXIT_OK, harness.stderr());
      match(harness.stdout(), /^platform +2 macOS \._\* \/ \.DS_Store file\(s\)$/m);
      match(harness.stderr(), /^WARN  \[ka\.doctor\] 2 macOS \._\* \/ \.DS_Store file\(s\) lie in the corpus; `ka doctor --fix` removes them$/m);
      doesNotMatch(harness.stderr(), /dot_clean/, "one remedy, not two");

      const release = new FileStore(harness.corpus).lock("sync --source bund");
      strictEqual(await run(["--corpus", harness.corpus, "doctor", "--fix"], harness.deps), EXIT_STORE, "not under a running sync");
      release();
      harness.out.length = 0;
      strictEqual(await run(["--corpus", harness.corpus, "doctor", "--fix"], harness.deps), EXIT_OK, harness.stderr());
      match(harness.stdout(), /^removed +2 macOS \._\* \/ \.DS_Store file\(s\)$/m);
      match(harness.stdout(), /^platform +no macOS \._\* \/ \.DS_Store files$/m);
      ok(!existsSync(join(harness.corpus, ".DS_Store")) && existsSync(join(harness.corpus, "records", "berlin-19-10006.json")));
    } finally {
      harness.cleanup();
    }
  });

  it("names a catalog apart from the record files in ka doctor", async () => {
    const harness = await seeded();
    try {
      rmSync(join(harness.corpus, "index", "catalog.json"));
      strictEqual(await run(["--corpus", harness.corpus, "doctor"], harness.deps), EXIT_STORE);
      match(harness.stdout(), /^catalog +\d+ record file\(s\), 0 catalog row\(s\): \d+ uncatalogued, 0 without a file$/m);
      match(harness.stderr(), /^ERROR \[ka\.doctor\] the catalog and the record files disagree: .* `ka reindex` rebuilds the catalog from the records$/m);
      strictEqual(await run(["--corpus", harness.corpus, "reindex"], harness.deps), EXIT_OK);
      strictEqual(await run(["--corpus", harness.corpus, "doctor"], harness.deps), EXIT_OK);

      harness.out.length = 0;
      strictEqual(await run(["--corpus", join(harness.corpus, "later"), "doctor"], harness.deps), EXIT_OK);
      match(harness.stdout(), /^corpus +.*later \(not created yet\)$/m);
      ok(!existsSync(join(harness.corpus, "later")));
    } finally {
      harness.cleanup();
    }
  });

  it("gives each --source a window of its own after @, the shared flags filling in the rest", async () => {
    const { transport, requests } = scriptedTransport([
      { match: "robots.txt", status: 404 },
      { match: "search.dip.bundestag.de", body: '{"numFound":0,"documents":[]}', headers: { "content-type": "application/json" } },
    ]);
    const harness = cliHarness({ transport, env: { DIP_API_KEY: "test-key" } });
    try {
      const argv = ["--corpus", harness.corpus, "sync", "--source", "bund@2026-01-01..2026-12-31", "--source", "bund@period=21", "--limit", "5"];
      strictEqual(await run(argv, harness.deps), EXIT_OK, harness.stderr());
      match(harness.stdout(), /^bund@2026-01-01\.\.2026-12-31: 0 discovered, 0 stored, 0 unchanged, 0 failed$/m);
      match(harness.stdout(), /^bund@period=21: 0 discovered, 0 stored, 0 unchanged, 0 failed$/m);
      const urls = requests.map((request) => request.url);
      ok(urls.some((url) => /f\.datum\.start=2026-01-01/.test(url) && !/f\.wahlperiode/.test(url)), urls.join("\n"));
      ok(urls.some((url) => /f\.wahlperiode=21/.test(url) && !/f\.datum\.start/.test(url)), urls.join("\n"));

      for (const [spec, reason] of [
        ["bund@period=0", /period in "bund@period=0"/],
        ["narnia@period=1", /narnia/],
        ["bund@2026", /is not a window/],
      ] as const) {
        harness.err.length = 0;
        strictEqual(await run(["--corpus", harness.corpus, "sync", "--source", spec], harness.deps), EXIT_USAGE, spec);
        match(harness.stderr(), reason, spec);
      }
      strictEqual(await run(["--corpus", harness.corpus, "sync", "--source", "bund@period=21", "--source", "bund@period=21"], harness.deps), EXIT_USAGE);
      match(harness.stderr(), /"bund@period=21" is named twice\./);
    } finally {
      harness.cleanup();
    }
  });

  describe("a plan file (--plan)", () => {
    const withPlan = async (text: string, body: (plan: string, dir: string) => Promise<void>): Promise<void> => {
      const dir = mkdtempSync(join(tmpdir(), "openka-plan-"));
      try {
        writeFileSync(join(dir, "jobs.toml"), text);
        await body(join(dir, "jobs.toml"), dir);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };

    it("runs its jobs, logs each where it says, and ends with a summary", async () => {
      await withPlan('[[job]]\nsource = "berlin"\nlog = "logs/{source}.log"\n', async (plan, dir) => {
        const harness = cliHarness({ transport: berlinTransport().transport });
        try {
          strictEqual(await run(["--corpus", harness.corpus, "sync", "--plan", plan], harness.deps), EXIT_OK, harness.stderr());
          match(harness.stdout(), /^berlin: \d+ discovered, \d+ stored/m);
          match(harness.stdout(), /^JOB +STATUS +DISCOVERED +STORED +UNCHANGED +FAILED$/m);
          match(harness.stdout(), /^berlin +done +\d+ +\d+ +0 +0$/m);
          match(harness.stderr(), /^INFO  \[ka\.sync\] every job of the plan is done; its next run starts over\.$/m);
          const log = harness.files.get(join(dir, "logs", "berlin.log"))?.toString("utf8") ?? "";
          // Each line is the text log record stderr would show, the job's label leading its message.
          match(log, /^2026-01-02T03:04:05\.000Z INFO  \[ka\.sync\] berlin: started$/m);
          match(log, /^2026-01-02T03:04:05\.000Z INFO  \[ka\.sync\] berlin: \d+ Anfragen discovered$/m);
          match(log, /^2026-01-02T03:04:05\.000Z INFO  \[ka\.sync\] berlin: 1\/\d+ stored berlin-19-\d+$/m);
          match(log, /^2026-01-02T03:04:05\.000Z INFO  \[ka\.sync\] berlin: done: \d+ discovered, \d+ stored, 0 unchanged, 0 failed$/m);
          deepStrictEqual(readdirSync(join(harness.corpus, "state", "queues")), [], "the round is closed");

          // A log is appended to, run after run.
          strictEqual(await run(["--corpus", harness.corpus, "sync", "--plan", plan], harness.deps), EXIT_OK, harness.stderr());
          strictEqual(harness.files.get(join(dir, "logs", "berlin.log"))?.toString("utf8").match(/ berlin: started$/gm)?.length, 2);
        } finally {
          harness.cleanup();
        }
      });
    });

    it("skips on a rerun the jobs done in its unfinished round, and runs them again with --restart", async () => {
      // The Bundestag job fails without a DIP key; Berlin's is done.
      await withPlan('[[job]]\nsource = "berlin"\n\n[[job]]\nsource = "bund"\nperiod = 21\n', async (plan) => {
        const { transport, requests } = berlinTransport();
        const harness = cliHarness({ transport });
        try {
          strictEqual(await run(["--corpus", harness.corpus, "sync", "--plan", plan], harness.deps), EXIT_USAGE);
          match(harness.stdout(), /^bund@period=21 +failed +— +— +— +—$/m);
          match(harness.stderr(), /^INFO  \[ka\.sync\] 1 job\(s\) of the plan are not done; run it again to continue \(--restart runs every job\)\.$/m);
          match(harness.stderr(), /DIP API needs a key/);

          const before = requests.length;
          harness.out.length = 0;
          harness.err.length = 0;
          strictEqual(await run(["--corpus", harness.corpus, "sync", "--plan", plan, "--json"], harness.deps), EXIT_USAGE);
          match(harness.stderr(), /^INFO  \[ka\.sync\] skipping 1 job\(s\) done in this plan's unfinished round \(begun 2026-01-02T03:04:05Z\): berlin\. --restart runs them again\.$/m);
          strictEqual(requests.length, before, "Berlin was not asked again");
          const json = JSON.parse(harness.stdout()) as { job: string; reason?: string; error?: string }[];
          deepStrictEqual(json.map((entry) => [entry.job, entry.reason ?? (entry.error === undefined ? "done" : "error")]), [
            ["berlin", "done-earlier"],
            ["bund@period=21", "error"],
          ]);

          harness.err.length = 0;
          strictEqual(await run(["--corpus", harness.corpus, "sync", "--plan", plan, "--restart"], harness.deps), EXIT_USAGE);
          doesNotMatch(harness.stderr(), /skipping/);
          ok(requests.length > before, "Berlin ran again");
        } finally {
          harness.cleanup();
        }
      });
    });

    it("starts no job after a failed one when continue_on_error is false", async () => {
      await withPlan('[defaults]\ncontinue_on_error = false\n\n[[job]]\nsource = "bund"\nperiod = [21, 20]\n', async (plan) => {
        const harness = cliHarness();
        try {
          strictEqual(await run(["--corpus", harness.corpus, "sync", "--plan", plan], harness.deps), EXIT_USAGE);
          match(harness.stdout(), /^bund@period=21 +failed/m);
          match(harness.stdout(), /^bund@period=20 +not started/m);
          match(harness.stderr(), /^WARN  \[ka\.sync\] 1 job\(s\) not started, since a job failed and the plan sets continue_on_error = false\.$/m);
        } finally {
          harness.cleanup();
        }
      });
    });

    it("sizes the whole queue with --dry-run", async () => {
      await withPlan('[[job]]\nsource = "berlin"\nsince = 2021-01-01\n\n[[job]]\nsource = "berlin"\nlimit = 1\n', async (plan) => {
        const { transport } = scriptedTransport([
          { match: "pardok-wp19.xml", body: PARDOK },
          { match: "robots.txt", status: 404 },
          { match: ".pdf", headers: { "content-length": "110000" } },
        ]);
        const harness = cliHarness({ transport });
        try {
          strictEqual(await run(["--corpus", harness.corpus, "sync", "--plan", plan, "--dry-run"], harness.deps), EXIT_OK, harness.stderr());
          match(harness.stdout(), /^berlin 2021-01-01\.\.: \d+ Anfragen discovered/m);
          match(harness.stdout(), /^berlin@limit=1: documents to fetch: 1 /m);
          match(harness.stdout(), /^total: \d+ Anfragen discovered, 0 already in corpus, \d+ documents to fetch \(≈ [\d.]+ (KB|MB)\)$/m);
          ok(!existsSync(join(harness.corpus, "state")), "nothing is written");
        } finally {
          harness.cleanup();
        }
      });
    });

    it("refuses what does not go with a plan, and a plan it cannot read", async () => {
      await withPlan('[[job]]\nsource = "berlin"\nperiod = 0\n', async (plan) => {
        const harness = cliHarness();
        try {
          for (const [argv, reason] of [
            [["--plan", plan, "--source", "berlin"], /--plan names its own jobs; leave out --source and --all\./],
            [["--plan", plan, "--all"], /--plan names its own jobs/],
            [["--plan", plan, "--since", "2026-01-01", "--limit", "5"], /put --since, --limit in the plan \(a job, or its \[defaults\]\) instead\./],
            [["--source", "berlin", "--restart"], /--restart applies to --plan only\./],
            [["--plan", `${plan}.missing`], /Could not read the plan .*jobs\.toml\.missing/],
            [["--plan", plan], /jobs\.toml \[\[job\]\] #1 \(berlin\): Invalid period/],
          ] as const) {
            harness.err.length = 0;
            strictEqual(await run(["--corpus", harness.corpus, "sync", ...argv], harness.deps), EXIT_USAGE, argv.join(" "));
            match(harness.stderr(), reason, argv.join(" "));
          }
          writeFileSync(plan, "[[job]]\nsource = 'berlin'\nsince = 2026-01-01T00:00:00\n");
          strictEqual(await run(["--corpus", harness.corpus, "sync", "--plan", plan], harness.deps), EXIT_USAGE);
          match(harness.stderr(), /jobs\.toml:3: 2026-01-01T00:00:00 is not a value a plan file reads/);
        } finally {
          harness.cleanup();
        }
      });
    });
  });

  describe("ka status (issue #15)", () => {
    /** A sync in progress in this process: the lock, and a status 35 minutes in, last moved at 03:04:00. */
    const running = (corpus: string): { release: () => void; recorder: RunStatusRecorder } => {
      const store = new FileStore(corpus);
      const release = store.lock("sync --source berlin");
      let t = Date.parse("2026-01-02T02:29:00Z");
      const recorder = new RunStatusRecorder(store, { command: "sync --source berlin", jobs: [{ job: "berlin", source: "berlin" }, { job: "bund", source: "bund" }], now: () => new Date(t) });
      recorder.start("berlin");
      recorder.discovered("berlin", 3476);
      for (let i = 1; i <= 280; i++) {
        t += 7_500; // 8 a minute
        recorder.progress("berlin", { index: i, total: 3476, action: "stored" });
      }
      return { release, recorder };
    };

    it("says what a running sync is doing, as text and as JSON", async () => {
      // The harness clock: 2026-01-02T03:04:05Z, 5 s after the last progress.
      const harness = cliHarness();
      try {
        const { release } = running(harness.corpus);
        strictEqual(await run(["--corpus", harness.corpus, "status"], harness.deps), EXIT_OK, harness.stderr());
        match(harness.stdout(), /^sync --source berlin {3}pid \d+ on \S+ {3}running 35 min$/m);
        match(harness.stdout(), /^ {2}berlin: 280\/3,476 · 0 failed · 8\/min \(last 10 min\) · last progress 5s ago · ~6h 40m left$/m);
        match(harness.stdout(), /^ {2}bund: waiting$/m);

        harness.out.length = 0;
        strictEqual(await run(["--corpus", harness.corpus, "status", "--json"], harness.deps), EXIT_OK);
        const report = JSON.parse(harness.stdout()) as { state: string; quiet_seconds: number; jobs: { job: string; rate_per_min?: number; eta_seconds?: number }[] };
        deepStrictEqual([report.state, report.quiet_seconds, report.jobs[0]?.rate_per_min, report.jobs[0]?.eta_seconds], ["running", 5, 8, 23_970]);

        // A scheduler's check: still moving, or not.
        strictEqual(await run(["--corpus", harness.corpus, "status", "--stalled-after", "1m"], harness.deps), EXIT_OK);
        strictEqual(await run(["--corpus", harness.corpus, "status", "--stalled-after", "5s"], harness.deps), EXIT_ERROR);
        match(harness.stderr(), /^ERROR \[ka\.status\] stalled: nothing has moved for 5s \(--stalled-after 5s\)$/m);
        strictEqual(await run(["--corpus", harness.corpus, "status", "--stalled-after", "soon"], harness.deps), EXIT_USAGE);
        release();
      } finally {
        harness.cleanup();
      }
    });

    it("is idle after a sync, and shows how the last run ended", async () => {
      const harness = await seeded();
      try {
        strictEqual(await run(["--corpus", harness.corpus, "status"], harness.deps), EXIT_OK, harness.stderr());
        match(harness.stdout(), /^idle — last run: sync --source berlin, finished 2026-01-02T03:04:05Z after 0s$/m);
        match(harness.stdout(), /^ {2}berlin: done · \d+ discovered, \d+ stored, 0 unchanged, 0 failed$/m);
        strictEqual(await run(["--corpus", harness.corpus, "status", "--stalled-after", "1s"], harness.deps), EXIT_OK, "an idle corpus is not stalled");

        const fresh = cliHarness();
        try {
          strictEqual(await run(["--corpus", fresh.corpus, "status"], fresh.deps), EXIT_OK);
          match(fresh.stdout(), /^idle — no sync has recorded a status in this corpus yet$/m);
          strictEqual(await run(["--corpus", join(fresh.corpus, "missing"), "status"], fresh.deps), EXIT_STORE);
        } finally {
          fresh.cleanup();
        }
      } finally {
        harness.cleanup();
      }
    });

    it("names a stale lock and another writer instead of leaving the user to guess", async () => {
      const harness = cliHarness();
      try {
        // A sync killed outright: its lock and its status name a process that is gone.
        running(harness.corpus);
        const gone = 4_194_304 * 8;
        const store = new FileStore(harness.corpus);
        store.putRunStatus({ ...(store.getRunStatus() as NonNullable<ReturnType<FileStore["getRunStatus"]>>), pid: gone });
        writeFileSync(join(harness.corpus, "lock"), JSON.stringify({ host: hostname(), pid: gone, purpose: "sync --source berlin" }));
        strictEqual(await run(["--corpus", harness.corpus, "status"], harness.deps), EXIT_OK);
        match(harness.stdout(), /^sync --source berlin {3}pid \d+ on \S+ {3}stale lock — the process is gone; last status$/m);
        match(harness.stderr(), /^INFO  \[ka\.status\] the lock was left by a run that is gone/m);
        strictEqual(await run(["--corpus", harness.corpus, "status", "--stalled-after", "1h"], harness.deps), EXIT_ERROR);
        match(harness.stderr(), /^ERROR \[ka\.status\] stalled: the run that holds the corpus is gone/m);

        rmSync(join(harness.corpus, "lock"));
        const release = new FileStore(harness.corpus).lock("reindex");
        harness.out.length = 0;
        strictEqual(await run(["--corpus", harness.corpus, "status"], harness.deps), EXIT_OK);
        match(harness.stdout(), /^busy: the corpus is held by reindex, pid \d+ on \S+ — no progress is kept for it$/m);
        release();
      } finally {
        harness.cleanup();
      }
    });

    it("looks again with --watch until the sync is done", async () => {
      const harness = cliHarness();
      try {
        const { release, recorder } = running(harness.corpus);
        const waits: number[] = [];
        harness.deps.sleep = async (ms) => {
          waits.push(ms);
          recorder.done("berlin", { state: "done", discovered: 3476, stored: 3476, unchanged: 0, failed: 0 });
          recorder.finish("finished");
          release();
        };
        strictEqual(await run(["--corpus", harness.corpus, "status", "--watch"], harness.deps), EXIT_OK);
        deepStrictEqual(waits, [5000]);
        match(harness.stdout(), /running 35 min[\s\S]*^idle — last run: sync --source berlin, finished/m);
      } finally {
        harness.cleanup();
      }
    });

    it("leaves the run's result behind when a sync is interrupted", async () => {
      const harness = cliHarness({ transport: berlinTransport().transport });
      try {
        let interrupt: ((signal: "SIGINT" | "SIGTERM") => void) | undefined;
        harness.deps.onInterrupt = (handler) => {
          interrupt = handler;
          return () => undefined;
        };
        const engine = harness.deps.createEngine;
        harness.deps.createEngine = (options) => {
          interrupt?.("SIGINT");
          return engine(options);
        };
        strictEqual(await run(["--corpus", harness.corpus, "sync", "--source", "berlin"], harness.deps), 130);
        const status = new FileStore(harness.corpus).getRunStatus();
        deepStrictEqual([status?.running, status?.result], [false, "interrupted"]);
      } finally {
        harness.cleanup();
      }
    });
  });

  describe("ka config (issue #18)", () => {
    const KEY = "OSOegLs.PR2lwJ1dwCeje9vTj7FPOt3hvpYKtwKkhw";
    const dip = (): ReturnType<typeof scriptedTransport> =>
      scriptedTransport([{ match: "search.dip.bundestag.de", body: '{"numFound":0,"documents":[]}', headers: { "content-type": "application/json" } }]);

    it("stores the DIP key from a prompt, never from an argument, and shows it masked", async () => {
      const harness = cliHarness();
      try {
        const prompts: string[] = [];
        harness.deps.io.readSecret = async (prompt) => {
          prompts.push(prompt);
          return `  ${KEY}\n`;
        };
        strictEqual(await run(["--corpus", harness.corpus, "config", "set", "bund.api-key"], harness.deps), EXIT_OK, harness.stderr());
        deepStrictEqual(prompts, ["bund.api-key: "]);
        const path = join(harness.config, "openka", "credentials");
        match(harness.stderr(), new RegExp(`^INFO  \\[ka\\.config\\] Stored bund\\.api-key \\(OSOe…Kkhw\\) in ${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.$`, "m"));
        deepStrictEqual(JSON.parse(readFileSync(path, "utf8")), { "bund.api-key": KEY });
        if (process.platform !== "win32") strictEqual(statSync(path).mode & 0o777, 0o600);

        harness.out.length = 0;
        strictEqual(await run(["--corpus", harness.corpus, "config", "get", "bund.api-key"], harness.deps), EXIT_OK);
        strictEqual(harness.stdout(), "OSOe…Kkhw");
        strictEqual(await run(["--corpus", harness.corpus, "config", "list"], harness.deps), EXIT_OK);
        match(harness.stdout(), /^bund\.api-key {2}OSOe…Kkhw$/m);
        ok(!harness.stdout().includes(KEY) && !harness.stderr().includes(KEY), "never in full unless asked");
        harness.out.length = 0;
        strictEqual(await run(["--corpus", harness.corpus, "config", "get", "bund.api-key", "--reveal"], harness.deps), EXIT_OK);
        strictEqual(harness.stdout(), KEY);

        // The value as an argument is refused, and not echoed back.
        harness.err.length = 0;
        strictEqual(await run(["--corpus", harness.corpus, "config", "set", "bund.api-key", "s3cret-value"], harness.deps), EXIT_USAGE);
        doesNotMatch(harness.stderr(), /s3cret-value/);
        match(harness.stderr(), /ka config set takes the name only/);
        for (const argv of [["config", "set", "berlin.api-key"], ["config", "get", "bund.password"]]) {
          strictEqual(await run(["--corpus", harness.corpus, ...argv], harness.deps), EXIT_USAGE, argv.join(" "));
        }
        match(harness.stderr(), /Not a credential name this program knows: expected one of bund\.api-key\./);
        harness.deps.io.readSecret = async () => "two words";
        strictEqual(await run(["--corpus", harness.corpus, "config", "set", "bund.api-key"], harness.deps), EXIT_USAGE);
        match(harness.stderr(), /a key is one token\. Nothing was stored\./);

        strictEqual(await run(["--corpus", harness.corpus, "config", "unset", "bund.api-key"], harness.deps), EXIT_OK);
        ok(!existsSync(path));
        strictEqual(await run(["--corpus", harness.corpus, "config", "get", "bund.api-key"], harness.deps), EXIT_ERROR);
        match(harness.stderr(), /No bund\.api-key is stored in .*; ka config set bund\.api-key stores one\./);
      } finally {
        harness.cleanup();
      }
    });

    it("lets ka sync take the stored key after --api-key and DIP_API_KEY", async () => {
      const harness = cliHarness({ transport: dip().transport });
      try {
        new CredentialStore(join(harness.config, "openka", "credentials")).set("bund.api-key", KEY);
        const authorizations = async (argv: string[], env: NodeJS.ProcessEnv = {}): Promise<string[]> => {
          const { transport, requests } = dip();
          const h = cliHarness({ transport, env: { XDG_CONFIG_HOME: harness.config, ...env } });
          try {
            strictEqual(await run(["--corpus", h.corpus, "sync", "--source", "bund", "--limit", "1", ...argv], h.deps), EXIT_OK, h.stderr());
            ok(!h.stdout().includes(KEY) && !h.stderr().includes(KEY), "the key is not printed");
            return [...new Set(requests.map((request) => String(request.headers?.["authorization"])))];
          } finally {
            rmSync(h.corpus, { recursive: true, force: true });
          }
        };
        deepStrictEqual(await authorizations([]), [`ApiKey ${KEY}`]);
        deepStrictEqual(await authorizations([], { DIP_API_KEY: "from-env" }), ["ApiKey from-env"]);
        deepStrictEqual(await authorizations(["--api-key", "from-flag"], { DIP_API_KEY: "from-env" }), ["ApiKey from-flag"]);

        // A credentials file others can read is not used: a corpus problem naming the fix.
        if (process.platform !== "win32") {
          chmodSync(join(harness.config, "openka", "credentials"), 0o644);
          strictEqual(await run(["--corpus", harness.corpus, "sync", "--source", "bund", "--limit", "1"], harness.deps), EXIT_STORE);
          match(harness.stderr(), /can be read by others \(mode 644\).*chmod 600/);
        }
      } finally {
        harness.cleanup();
      }
    });

    it("refuses a credentials file inside the corpus", async () => {
      const harness = cliHarness({ env: {} });
      try {
        harness.deps.env = { XDG_CONFIG_HOME: join(harness.corpus, "config") };
        harness.deps.io.readSecret = async () => KEY;
        strictEqual(await run(["--corpus", harness.corpus, "config", "set", "bund.api-key"], harness.deps), EXIT_USAGE);
        match(harness.stderr(), /would be inside the corpus .*; set XDG_CONFIG_HOME to a directory outside it\./);
        ok(!existsSync(join(harness.corpus, "config")));
      } finally {
        harness.cleanup();
      }
    });

    it("never echoes a key typed in place of the name, in any config command (C2)", async () => {
      const harness = cliHarness();
      try {
        harness.deps.io.readSecret = async () => KEY;
        const typed = "abcSECRET-personal-key-123";
        for (const argv of [
          ["config", "set", typed],
          ["config", "get", typed],
          ["config", "get", typed, "--reveal"],
          ["config", "unset", typed],
          ["config", "get", "bund.api-key", typed],
          ["config", "unset", "bund.api-key", typed],
          ["config", "list", typed],
          ["--log-format", "jsonl", "config", "set", typed],
        ]) {
          harness.err.length = 0;
          strictEqual(await run(["--corpus", harness.corpus, ...argv], harness.deps), EXIT_USAGE, argv.join(" "));
          ok(!harness.stderr().includes("SECRET"), `${argv.join(" ")}:\n${harness.stderr()}`);
          match(harness.stderr(), /ERROR.*ka\.cli/, argv.join(" "));
        }
        harness.err.length = 0;
        strictEqual(await run(["--corpus", harness.corpus, "config", "get", typed], harness.deps), EXIT_USAGE);
        match(harness.stderr(), /Not a credential name this program knows: expected one of bund\.api-key\./);
      } finally {
        harness.cleanup();
      }
    });

    it("names the credentials file when the config location cannot be written, for set and for the last unset (C4)", async (t) => {
      if (process.platform === "win32" || process.getuid?.() === 0) return t.skip("needs POSIX permissions and a non-root user");
      const harness = cliHarness();
      const dir = join(harness.config, "openka");
      try {
        harness.deps.io.readSecret = async () => KEY;
        // The config home cannot be written: mkdir of openka/ fails.
        chmodSync(harness.config, 0o500);
        strictEqual(await run(["--corpus", harness.corpus, "config", "set", "bund.api-key"], harness.deps), EXIT_STORE, harness.stderr());
        match(harness.stderr(), /Could not write the credentials file .*credentials: EACCES/);
        doesNotMatch(harness.stderr(), /Unexpected error/);
        chmodSync(harness.config, 0o700);

        // The last name removed from a file in a directory that cannot be written: rm fails.
        harness.err.length = 0;
        const store = new CredentialStore(join(dir, "credentials"));
        store.set("bund.api-key", KEY);
        chmodSync(dir, 0o500);
        strictEqual(await run(["--corpus", harness.corpus, "config", "unset", "bund.api-key"], harness.deps), EXIT_STORE, harness.stderr());
        match(harness.stderr(), /Could not write the credentials file .*credentials: EACCES/);
        doesNotMatch(harness.stderr(), /Unexpected error/);
        chmodSync(dir, 0o700);
        strictEqual(store.get("bund.api-key"), KEY, "nothing was lost");
      } finally {
        chmodSync(harness.config, 0o700);
        if (existsSync(dir)) chmodSync(dir, 0o700);
        harness.cleanup();
      }
    });

    it("reads a secret without echo on a terminal, and whole from a pipe", async () => {
      const written: string[] = [];
      const stderr = { write: (text: string) => (written.push(text), true) };
      const fakeTty = (keys: string): NodeJS.ReadStream => {
        const emitter = new EventEmitter() as unknown as NodeJS.ReadStream & { raw: boolean[] };
        const raw: boolean[] = [];
        Object.assign(emitter, {
          isTTY: true,
          raw,
          setRawMode: (on: boolean) => (raw.push(on), emitter),
          resume: () => {
            setImmediate(() => emitter.emit("data", Buffer.from(keys)));
            return emitter;
          },
          pause: () => emitter,
        });
        return emitter;
      };
      strictEqual(await readSecretFrom(fakeTty("abX\u007fc\r"), stderr, "key: "), "abc");
      deepStrictEqual(written, ["key: ", "\n"], "the prompt and a newline, never a typed character");
      await rejects(readSecretFrom(fakeTty("ab\u0003"), stderr, "key: "), (err: unknown) => err instanceof InterruptedRunError && err.exitCode === 130);
      const { PassThrough } = await import("node:stream");
      const pipe = new PassThrough();
      pipe.end(`${KEY}\n`);
      strictEqual(await readSecretFrom(pipe, stderr, "unused: "), KEY);
    });
  });

  describe("after an upgrade (issue #13)", () => {
    const OLD = "pkg:0.2.0+extract:6f021d93d3c3";
    /** The seeded record as an older build stamped it, its content changed by `change`. */
    const restamp = (corpus: string, change: (record: KaRecord) => KaRecord = (record) => record): void => {
      const store = new FileStore(corpus);
      const stored = store.getRecord("berlin-19-10006") as KaRecord;
      store.putRecord(change({ ...stored, extraction: { ...stored.extraction, extractor_version: OLD } }));
    };

    it("verifies the content under a new version, and exits 5 when only the stamp moved", async () => {
      const harness = await seeded();
      try {
        restamp(harness.corpus);
        strictEqual(await run(["--corpus", harness.corpus, "verify", "--all"], harness.deps), EXIT_VERSION_ONLY);
        match(harness.stdout(), new RegExp(`^VERSION berlin-19-10006: produced by ${OLD.replace(/[.+]/g, "\\$&")}, content identical under pkg:`, "m"));
        match(harness.stdout(), /^2\/3 record\(s\) reproduced byte-identically\. 1 more reproduce in content but carry another extractor version — `ka reextract` restamps them\.$/m);
        doesNotMatch(harness.stdout(), /^FAIL/m);

        restamp(harness.corpus, (record) => ({ ...record, full_text: "etwas anderes" }));
        harness.out.length = 0;
        strictEqual(await run(["--corpus", harness.corpus, "verify", "--all"], harness.deps), EXIT_ERROR);
        match(harness.stdout(), /^DIFF berlin-19-10006: content differs at full_text \(produced by pkg:0\.2\.0\+extract:6f021d93d3c3, this build is pkg:/m);
        match(harness.stdout(), / 1 differ in content\.$/m);
      } finally {
        harness.cleanup();
      }
    });

    it("re-extracts offline with ka reextract, and verify passes afterwards", async () => {
      const harness = await seeded();
      try {
        restamp(harness.corpus);
        strictEqual(await run(["--corpus", harness.corpus, "reextract", "--all", "--dry-run"], harness.deps), EXIT_OK, harness.stderr());
        match(harness.stdout(), /^Would re-extract 1 of 3 record\(s\) with pkg:\S+: 1 only restamped \(content identical\), 0 changed \(0 newly complete, 0 newly abstained\); 2 already current\.$/m);
        match(harness.stdout(), /^Nothing was written \(--dry-run\)\.$/m);
        strictEqual(new FileStore(harness.corpus).getRecord("berlin-19-10006")?.extraction.extractor_version, OLD);

        // The record moved in content too, and the run says how; no request is made.
        restamp(harness.corpus, (record) => ({ ...record, full_text: "alt" }));
        harness.out.length = 0;
        strictEqual(await run(["--corpus", harness.corpus, "reextract", "--parliament", "berlin"], harness.deps), EXIT_OK, harness.stderr());
        match(harness.stdout(), /^CHANGED berlin-19-10006: full_text$/m);
        match(harness.stdout(), /^Wrote 1 record\(s\) and rebuilt the index and catalog\.$/m);
        strictEqual(await run(["--corpus", harness.corpus, "verify", "--all"], harness.deps), EXIT_OK);

        harness.out.length = 0;
        strictEqual(await run(["--corpus", harness.corpus, "reextract", "berlin-19-10006", "--json"], harness.deps), EXIT_OK);
        const report = JSON.parse(harness.stdout()) as { counts: { current: number }; written: number };
        deepStrictEqual([report.counts.current, report.written], [1, 0]);
      } finally {
        harness.cleanup();
      }
    });

    it("asks which records, refuses ids beside a selection, and says what it could not read", async () => {
      const harness = await seeded();
      try {
        strictEqual(await run(["--corpus", harness.corpus, "reextract"], harness.deps), EXIT_USAGE);
        match(harness.stderr(), /Name the records: ids, --all, or filters such as --parliament berlin --year 2025\./);
        strictEqual(await run(["--corpus", harness.corpus, "reextract", "berlin-19-10006", "--all"], harness.deps), EXIT_USAGE);
        match(harness.stderr(), /not both/);
        strictEqual(await run(["--corpus", harness.corpus, "reextract", "BERLIN"], harness.deps), EXIT_USAGE);

        restamp(harness.corpus);
        const record = new FileStore(harness.corpus).getRecord("berlin-19-10006") as KaRecord;
        rmSync(new FileStore(harness.corpus).blobPath(record.source_documents[0]?.sha256 as string));
        harness.err.length = 0;
        strictEqual(await run(["--corpus", harness.corpus, "reextract", "--all"], harness.deps), EXIT_STORE);
        match(harness.stderr(), /^WARN  \[ka\.reextract\] skipped berlin-19-10006: archived bytes for .* are missing$/m);
        match(harness.stderr(), /^ERROR \[ka\.store\] 1 record\(s\) could not be read and were left as they are$/m);
      } finally {
        harness.cleanup();
      }
    });
  });

  describe("ka stats (issue #16)", () => {
    it("says coverage, questions, extractor versions and disk use by default", async () => {
      const harness = await seeded();
      try {
        strictEqual(await run(["--corpus", harness.corpus, "stats"], harness.deps), EXIT_OK, harness.stderr());
        match(harness.stdout(), /^Coverage: asked 2021-11-04 to 2021-11-04; 18 questions; 0 without an answer date$/m);
        match(harness.stdout(), /^Extractor: pkg:\S+ {2}3 record\(s\) \(this build\)$/m);
        match(harness.stdout(), /^On disk: .*; [\d.]+ KB in all, [\d.]+ KB per Anfrage$/m);
        doesNotMatch(harness.stdout(), /ka reextract/);

        // One record from an older build: two lines, and what to do about it.
        const store = new FileStore(harness.corpus);
        const old = store.getRecord("berlin-19-10006") as KaRecord;
        store.putRecord({ ...old, extraction: { ...old.extraction, extractor_version: "pkg:0.2.0+extract:6f021d93d3c3" } });
        strictEqual(await run(["--corpus", harness.corpus, "reindex"], harness.deps), EXIT_OK);
        harness.out.length = 0;
        strictEqual(await run(["--corpus", harness.corpus, "stats"], harness.deps), EXIT_OK);
        match(harness.stdout(), /^Extractor: pkg:\S+ +2 record\(s\) \(this build\)\n {11}pkg:0\.2\.0\+extract:6f021d93d3c3 +1 record\(s\)\n {2}1 record\(s\) were made by another build — `ka reextract --all` brings them to this one\.$/m);
      } finally {
        harness.cleanup();
      }
    });

    it("breaks the records down --by one dimension or two, within the search filters", async () => {
      const harness = await seeded();
      try {
        strictEqual(await run(["--corpus", harness.corpus, "stats", "--by", "party", "--no-disk"], harness.deps), EXIT_OK, harness.stderr());
        match(harness.stdout(), /^PARTY +RECORDS {2}NEEDS REVIEW\nAfD +1 {2}0 \(0%\)\nGrüne +1 {2}0 \(0%\)\nSPD +1 {2}0 \(0%\)$/m);

        harness.out.length = 0;
        strictEqual(await run(["--corpus", harness.corpus, "stats", "--by", "ministry", "--by", "year", "--no-disk"], harness.deps), EXIT_OK);
        match(harness.stdout(), /^MINISTRY +YEAR +RECORDS {2}NEEDS REVIEW\nSenatsverwaltung für Umwelt, Verkehr und Klimaschutz {2}2021 +2 {2}0 \(0%\)$/m);

        harness.out.length = 0;
        strictEqual(await run(["--corpus", harness.corpus, "stats", "--party", "spd", "--by", "month", "--json", "--no-disk"], harness.deps), EXIT_OK);
        const json = JSON.parse(harness.stdout()) as { records: number; breakdown: { by: string[]; rows: { keys: unknown[]; records: number }[] } };
        deepStrictEqual([json.records, json.breakdown.by, json.breakdown.rows], [1, ["month"], [{ keys: ["2021-11"], records: 1, needs_review: 0 }]]);

        harness.out.length = 0;
        strictEqual(await run(["--corpus", harness.corpus, "stats", "--year", "2020", "--no-disk"], harness.deps), EXIT_OK);
        match(harness.stdout(), /^0 of 3 record\(s\) in .* match the filters\nNo record matches the filters\.$/m);

        for (const argv of [["--by", "colour"], ["--by", "party", "--by", "year", "--by", "month"], ["--by", "party", "--by", "party"]]) {
          strictEqual(await run(["--corpus", harness.corpus, "stats", ...argv], harness.deps), EXIT_USAGE, argv.join(" "));
        }
      } finally {
        harness.cleanup();
      }
    });
  });

  describe("a source's request floor (issue #24)", () => {
    const blocked = (): ReturnType<typeof scriptedTransport> => scriptedTransport([{ match: "robots.txt", body: "User-agent: *\nDisallow: /\n" }]);

    it("shows it in sources show and in the help", async () => {
      const harness = cliHarness();
      try {
        strictEqual(await run(["sources", "show", "sachsen-anhalt"], harness.deps), EXIT_OK);
        match(harness.stdout(), /^requests: {3}at most one request per 4 s per host — its document server's robots\.txt disallows every client.*; --min-host-interval can raise this, not lower it$/m);
        harness.out.length = 0;
        strictEqual(await run(["sources", "show", "berlin"], harness.deps), EXIT_OK);
        match(harness.stdout(), /^requests: {3}at most one request per 0\.5 s per host \(the default; --min-host-interval changes it\)$/m);
        harness.out.length = 0;
        strictEqual(await run(["--help"], harness.deps), EXIT_OK);
        match(harness.stdout().replace(/\s+/g, " "), /--min-host-interval <ms> minimum delay between requests to one host \(default: 500\); a source's own floor \(ka sources show <key>\) is never lowered by it/);
        match(harness.stdout().replace(/\s+/g, " "), /--max-response-bytes <n> hard cap on a single response body \(default: 134217728, 128 MiB\); a document over it is left out of its record, with a warning/);
      } finally {
        harness.cleanup();
      }
    });

    it("says before a sync why a source goes slowly, and when a lower --min-host-interval was kept out", async () => {
      for (const [flags, expected] of [
        [[], /^INFO  \[ka\.http\] sachsen-anhalt: at most one request per 4 s per host — /m],
        [["--min-host-interval", "1000"], /^INFO  \[ka\.http\] sachsen-anhalt: keeping the source's floor of 4000 ms between requests to a host; --min-host-interval 1000 can raise it, not lower it\.$/m],
        [["--min-host-interval", "1000", "--quiet"], /^INFO  \[ka\.http\] sachsen-anhalt: keeping the source's floor/m],
        [["--quiet"], undefined],
        [["--min-host-interval", "5000"], undefined],
      ] as const) {
        const harness = cliHarness({ transport: blocked().transport });
        try {
          strictEqual(await run(["--corpus", harness.corpus, ...flags, "sync", "--source", "sachsen-anhalt"], harness.deps), EXIT_OK, flags.join(" "));
          if (expected === undefined) doesNotMatch(harness.stderr(), /^INFO  \[ka\.http\] sachsen-anhalt:/m, flags.join(" "));
          else match(harness.stderr(), expected, flags.join(" "));
        } finally {
          harness.cleanup();
        }
      }
      const plain = cliHarness({ transport: berlinTransport().transport });
      try {
        strictEqual(await run(["--corpus", plain.corpus, "sync", "--source", "berlin"], plain.deps), EXIT_OK);
        doesNotMatch(plain.stderr(), /request per/, "a source at the default says nothing");
      } finally {
        plain.cleanup();
      }
    });
  });

  describe("fields a parliament never provides (issue #22)", () => {
    /** Two Sachsen-Anhalt records without a question date, one of them also without an answer. */
    const seedSaxony = (corpus: string): void => {
      const store = new FileStore(corpus);
      for (const [n, fields] of [[1, ["dates.submitted"]], [2, ["dates.submitted", "qa[0].answer"]]] as const) {
        const record = sampleRecord({
          id: `sachsen-anhalt-8-${n}`,
          parliament: "sachsen-anhalt",
          reference: `8/${n}`,
          legislative_period: 8,
          extraction: { ...sampleRecord().extraction, parse_complete: false, abstained_fields: [...fields], review_status: "needs_review" },
        });
        store.putRecord(record);
        indexRecord(store, record);
      }
    };

    it("keeps them out of ka review, says so, and lists them with --include-known-gaps", async () => {
      const harness = cliHarness();
      try {
        seedSaxony(harness.corpus);
        strictEqual(await run(["--corpus", harness.corpus, "review", "--parliament", "sachsen-anhalt"], harness.deps), EXIT_OK, harness.stderr());
        match(harness.stdout(), /^sachsen-anhalt-8-2 /m);
        doesNotMatch(harness.stdout(), /^sachsen-anhalt-8-1 /m);
        match(harness.stderr(), /^INFO  \[ka\.review\] 1 record\(s\) left out: their only holes are fields the parliament never provides \(sachsen-anhalt: dates\.submitted\)\. --include-known-gaps lists them too\.$/m);

        harness.out.length = 0;
        strictEqual(await run(["--corpus", harness.corpus, "review", "--source", "sachsen-anhalt", "--include-known-gaps"], harness.deps), EXIT_OK);
        match(harness.stdout(), /^sachsen-anhalt-8-1 /m);

        harness.out.length = 0;
        strictEqual(await run(["--corpus", harness.corpus, "review", "--group-by", "field"], harness.deps), EXIT_OK);
        match(harness.stdout(), /^sachsen-anhalt: 1 record\(s\) in the queue$/m);
        match(harness.stdout(), /^ {2}dates\.submitted +1 +1 {2}sachsen-anhalt-8-2 {2}\(never provided by the parliament\)$/m);

        strictEqual(await run(["--corpus", harness.corpus, "review", "--parliament", "berlin", "--source", "berlin"], harness.deps), EXIT_USAGE);
        match(harness.stderr(), /--source is another name for --parliament; give one of them\./);
      } finally {
        harness.cleanup();
      }
    });

    it("counts them apart in ka stats, and names them in ka sources show", async () => {
      const harness = cliHarness();
      try {
        seedSaxony(harness.corpus);
        strictEqual(await run(["--corpus", harness.corpus, "stats", "--no-disk"], harness.deps), EXIT_OK, harness.stderr());
        match(harness.stdout(), /^0 parse-complete \(0\.0%\), 2 with abstained fields \(1 only where the parliament never provides the field\)$/m);
        match(harness.stdout(), /^ {2}sachsen-anhalt: 2 record\(s\), 2 needing review \(1 only where the parliament never provides the field\)$/m);
        harness.out.length = 0;
        strictEqual(await run(["sources", "show", "sachsen-anhalt"], harness.deps), EXIT_OK);
        match(harness.stdout(), /^never has: dates\.submitted — question and answer are published as one Drucksache, dated by the answer; /m);
      } finally {
        harness.cleanup();
      }
    });
  });

  describe("the event log in JSON Lines (issue #10)", () => {
    type Event = { ts: string; level: string; topic: string; msg: string; event?: string; job?: string; source?: string; id?: string; status?: string; [key: string]: unknown };
    const parse = (text: string): Event[] => text.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as Event);

    it("writes each event as a ka.sync record on stderr with --log-format jsonl, the record's keys first", async () => {
      const harness = cliHarness({ transport: berlinTransport().transport });
      try {
        strictEqual(await run(["--corpus", harness.corpus, "sync", "--source", "berlin", "--log-format", "jsonl"], harness.deps), EXIT_OK, harness.stderr());
        const lines = harness.err.join("\n").split("\n");
        const events = parse(harness.err.join("\n"));
        strictEqual(events.length, lines.length, "every line on stderr is a JSON record");
        const kinds = events.flatMap((event) => (event.event === undefined ? [] : [event.event]));
        deepStrictEqual([kinds[0], kinds[1], kinds.at(-2), kinds.at(-1)], ["start", "discovered", "done", "report"]);
        const start = events.find((event) => event.event === "start");
        deepStrictEqual(Object.keys(start ?? {}), ["ts", "level", "topic", "msg", "event", "job", "source"]);
        deepStrictEqual([start?.ts, start?.level, start?.topic, start?.msg], ["2026-01-02T03:04:05.000Z", "INFO", "ka.sync", "berlin: started"]);
        const discovered = events.find((event) => event.event === "discovered");
        match(discovered?.msg ?? "", /^berlin: \d+ Anfragen discovered$/);
        const records = events.filter((event) => event.event === "record");
        ok(records.length > 0 && records.every((event) => event.source === "berlin" && event.status === "stored" && typeof event.ms === "number" && event.level === "INFO"));
        deepStrictEqual(Object.keys(records[0] ?? {}).slice(0, 8), ["ts", "level", "topic", "msg", "event", "job", "source", "id"]);
        strictEqual(records[0]?.msg, `${records[0]?.id} stored`);
        strictEqual(records[0]?.bytes, PDF.length, "the first record fetched the document");
        const done = events.find((event) => event.event === "done");
        match(done?.msg ?? "", /^berlin: done — \d+ stored, 0 unchanged, 0 failed$/);
        deepStrictEqual([events.at(-1)?.level, events.at(-1)?.msg], ["INFO", "report of 1 job(s)"]);
        deepStrictEqual(Object.keys(events.at(-1)?.["reports"] as object), ["0"]);
        match(harness.stdout(), /^berlin: \d+ discovered, \d+ stored/m, "stdout keeps its summary");

        strictEqual(await run(["--corpus", harness.corpus, "sync", "--source", "berlin", "--log-format", "xml"], harness.deps), EXIT_USAGE);
      } finally {
        harness.cleanup();
      }
    });

    it("takes --log-format jsonl before the command too: it is the program's", async () => {
      const harness = cliHarness({ transport: berlinTransport().transport });
      try {
        strictEqual(await run(["--log-format=jsonl", "--corpus", harness.corpus, "sync", "--source", "berlin"], harness.deps), EXIT_OK, harness.stderr());
        const events = parse(harness.err.join("\n"));
        ok(events.some((event) => event.event === "done"));
        ok(events.every((event) => event.topic === "ka.sync"), "no progress line, and nothing else");
      } finally {
        harness.cleanup();
      }
    });

    it("appends the same records to --log-file and keeps the progress records, naming each document's gap", async () => {
      // The PDF answers 404: the record is stored with a hole, and the event says which URL and why.
      const { transport } = scriptedTransport([
        { match: "pardok-wp19.xml", body: PARDOK },
        { match: ".pdf", status: 404 },
      ]);
      const harness = cliHarness({ transport });
      const log = join(harness.corpus, "..", "openka-events.jsonl");
      try {
        strictEqual(await run(["--corpus", harness.corpus, "sync", "--source", "berlin", "--log-file", log], harness.deps), EXIT_OK, harness.stderr());
        match(harness.stderr(), /^INFO  \[ka\.sync\] berlin: \d+ Anfragen discovered$/m, "the text progress stays on stderr");
        const events = parse(harness.files.get(log)?.toString("utf8") ?? "");
        ok(events.every((event) => event.ts === "2026-01-02T03:04:05.000Z" && typeof event.level === "string" && typeof event.msg === "string"));
        const record = events.find((event) => event.event === "record");
        deepStrictEqual((record?.["gaps"] as { gap: string; url: string }[] | undefined)?.map((gap) => [gap.gap, gap.url.endsWith(".pdf")]), [["404", true]]);
        ok(Array.isArray(record?.["abstained"]), "a record stored with holes names them");
        const warning = events.find((event) => event.event === "warning");
        deepStrictEqual([warning?.level, warning?.topic], ["WARN", "ka.sync"]);
        ok(String(warning?.["message"]).includes("now answers 404"));
        ok(!events.some((event) => /^berlin: \d+\/\d+ · /.test(event.msg)), "the progress records are stderr's only");
        // Run again: the file is appended to.
        strictEqual(await run(["--corpus", harness.corpus, "sync", "--source", "berlin", "--log-file", log], harness.deps), EXIT_OK);
        strictEqual(parse(harness.files.get(log)?.toString("utf8") ?? "").filter((event) => event.event === "start").length, 2);
      } finally {
        harness.cleanup();
      }
    });

    it("writes the sync's other diagnostics as records of their own area, so the stream stays JSON", async () => {
      const harness = cliHarness({ transport: scriptedTransport([{ match: "robots.txt", body: "User-agent: *\nDisallow: /\n" }]).transport });
      const log = join(harness.corpus, "..", "openka-notes.jsonl");
      try {
        strictEqual(await run(["--corpus", harness.corpus, "sync", "--source", "sachsen-anhalt", "--log-format", "jsonl", "--log-file", log], harness.deps), EXIT_OK);
        for (const events of [parse(harness.err.join("\n")), parse(harness.files.get(log)?.toString("utf8") ?? "")]) {
          const floor = events.find((event) => event.topic === "ka.http");
          deepStrictEqual(Object.keys(floor ?? {}), ["ts", "level", "topic", "msg"]);
          match(floor?.msg ?? "", /^sachsen-anhalt: at most one request per 4 s/);
          ok(events.some((event) => event.event === "done" && typeof event["blocked"] === "string"));
          ok(!events.some((event) => event.event === "note"), "no note events any more");
        }
      } finally {
        harness.cleanup();
      }
    });

    it("logs a failed job as an ERROR record, and the --log-file gets the error the run ends with", async () => {
      const harness = cliHarness({ transport: scriptedTransport([{ match: "pardok-wp19.xml", body: PARDOK }, { match: ".pdf", status: 500 }]).transport });
      const log = join(harness.corpus, "..", "openka-failed.jsonl");
      try {
        const code = await run(["--corpus", harness.corpus, "--max-retries", "0", "sync", "--source", "berlin", "--source", "bund", "--log-format", "jsonl", "--log-file", log], harness.deps);
        ok(code !== EXIT_OK);
        const events = parse(harness.err.join("\n"));
        const failedJob = events.find((event) => event.event === "failed");
        deepStrictEqual([failedJob?.level, failedJob?.job], ["ERROR", "bund"]);
        match(failedJob?.msg ?? "", /^bund: failed: /);
        deepStrictEqual(parse(harness.files.get(log)?.toString("utf8") ?? ""), events, "the file has every record stderr has");
        const last = events.at(-1);
        deepStrictEqual([last?.level, last?.event], ["ERROR", undefined], "the run's own error closes both");
      } finally {
        harness.cleanup();
      }
    });
  });

  describe("an unchanged feed and a new window (issue #11)", () => {
    /** Berlin's feed as the server serves it: 304 to a matching If-None-Match. */
    const conditional = (): { transport: Transport; feeds: string[] } => {
      const feeds: string[] = [];
      const transport: Transport = async (request) => {
        if (request.url.includes("pardok-wp19.xml")) {
          const match = request.headers?.["if-none-match"] === '"feed-v1"';
          feeds.push(match ? "304" : "200");
          return match ? { status: 304, headers: {}, body: Buffer.alloc(0) } : { status: 200, headers: { etag: '"feed-v1"' }, body: Buffer.from(PARDOK) };
        }
        return { status: 200, headers: { etag: '"pdf-v1"' }, body: PDF };
      };
      return { transport, feeds };
    };

    it("discovers a window the last run did not cover, though the feed did not change", async () => {
      const { transport, feeds } = conditional();
      const harness = cliHarness({ transport });
      try {
        // A window with nothing in it: the feed is read, and its ETag kept.
        strictEqual(await run(["--corpus", harness.corpus, "sync", "--source", "berlin", "--since", "2030-01-01"], harness.deps), EXIT_OK, harness.stderr());
        // Another window of the same, unchanged feed: it must be looked at.
        harness.out.length = 0;
        strictEqual(await run(["--corpus", harness.corpus, "sync", "--source", "berlin", "--since", "2021-01-01"], harness.deps), EXIT_OK, harness.stderr());
        match(harness.stdout(), /^berlin: [1-9]\d* discovered, [1-9]\d* stored/m);
        // The same window again: now the shortcut is right, and says so.
        harness.out.length = 0;
        strictEqual(await run(["--corpus", harness.corpus, "sync", "--source", "berlin", "--since", "2021-01-01"], harness.deps), EXIT_OK);
        match(harness.stdout(), /^berlin: upstream reports no change since the last complete sync of this window — nothing to do \(--force rediscovers\)\.$/m);
        deepStrictEqual(feeds, ["200", "200", "304"]);
      } finally {
        harness.cleanup();
      }
    });
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

  it("says why search found nothing when the index does not cover the records", async () => {
    // "No matches." alone read as an answer when the catalog lacked the records or the
    // token index was gone (exploratory test of 0.4.0).
    const harness = await seeded();
    try {
      writeFileSync(join(harness.corpus, "index", "catalog.json"), "[]");
      strictEqual(await run(["--corpus", harness.corpus, "search", "solaranlagen"], harness.deps), EXIT_OK);
      match(harness.stdout(), /No matches\./);
      match(harness.stderr(), /record file\(s\) are not in the catalog.*`ka reindex` adds them/);
      strictEqual(await run(["--corpus", harness.corpus, "reindex"], harness.deps), EXIT_OK);
      rmSync(join(harness.corpus, "index", "tokens"), { recursive: true });
      harness.out.length = 0;
      harness.err.length = 0;
      strictEqual(await run(["--corpus", harness.corpus, "search", "solaranlagen"], harness.deps), EXIT_OK);
      match(harness.stderr(), /the search index is empty although the catalog lists \d+ record\(s\).*`ka reindex` rebuilds it/);
      // A real "no match" on a healthy index says nothing extra.
      strictEqual(await run(["--corpus", harness.corpus, "reindex"], harness.deps), EXIT_OK);
      harness.err.length = 0;
      strictEqual(await run(["--corpus", harness.corpus, "search", "zzzzqqq"], harness.deps), EXIT_OK);
      doesNotMatch(harness.stderr(), /Note:/);
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
      // No catalogued record, so no rate — it printed "0 parse-complete (NaN%)".
      match(harness.stdout(), /^0 parse-complete, 0 with abstained fields$/m);
      doesNotMatch(harness.stdout(), /NaN/);
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

  it("fails `goldens list` on an empty set, as `goldens verify` does", async () => {
    // list used to print "No goldens in …" and exit 0 where verify exited 1.
    const empty = mkdtempSync(join(tmpdir(), "openka-goldens-"));
    try {
      for (const [command, tail] of [["list", "."], ["verify", " — nothing to verify."]] as const) {
        const harness = cliHarness();
        strictEqual(await runFactory(["goldens", command, "--dir", empty], harness.deps), EXIT_ERROR, command);
        strictEqual(harness.stderr().trim(), `ERROR [ka-factory.goldens] No goldens in ${empty}${tail}`, command);
        strictEqual(harness.stdout(), "", command);
        harness.cleanup();
      }
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
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
      const installed = text.indexOf("handleOutputErrors(");
      ok(installed > 0, `${bin} does not install handleOutputErrors`);
      ok(installed < text.search(/await run(?:Factory)?\(/), `${bin} runs before it installs the handler`);
    }
  });
});

describe("sync warnings", () => {
  it("prints a fallback warning whole and names the aggregator it fell back to", async () => {
    // It read "… — fell back to mecklenburg-vorpommern, so these records came from the
    // aggregator rather …": the aggregator carries the Land's own key, and every warning
    // was cut at 200 characters.
    const { transport } = scriptedTransport([
      { match: "Fulltext/Search", body: "<html>Wartungsarbeiten</html>" },
      { match: "robots.txt", status: 404, body: "" },
      { match: "parlamentsspiegel.de", body: "<html><body><div id=\"iTreffer\"></div></body></html>" },
    ]);
    const harness = cliHarness({ transport });
    try {
      await run(["--corpus", harness.corpus, "sync", "--source", "mecklenburg-vorpommern", "--limit", "1"], harness.deps);
      match(
        harness.stderr(),
        /^WARN  \[ka\.sync\] mecklenburg-vorpommern: Parldok answered in a form this adapter does not know \(not a Parldok success envelope\) — fell back to Parlamentsspiegel \(Landtag Mecklenburg-Vorpommern\), so these records came from the aggregator rather than from the parliament itself$/m,
      );
    } finally {
      harness.cleanup();
    }
  });
});
