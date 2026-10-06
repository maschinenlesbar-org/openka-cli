// The CLI, driven in-process through `run()` with a real temporary corpus, a
// scripted transport and a fixed clock. No subprocess, no network.

import { deepStrictEqual, doesNotMatch, match, ok, strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT_ERROR, EXIT_OK, EXIT_STORE, EXIT_USAGE, run } from "../src/run.js";
import { runFactory } from "@maschinenlesbar.org/openka-cli-ka-factory";
import { parseIsoDate, parseBoundedInt, parseNonEmpty } from "../src/shared.js";
import { resolveCorpusRoot } from "@maschinenlesbar.org/openka-lib-store";
import { escapeControlChars, sanitizeForTerminal, truncate } from "../src/text.js";
import { renderShowLines } from "../src/commands/query.js";
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
      strictEqual(await run(["--corpus", harness.corpus, "verify", "berlin-19-10006"], harness.deps), EXIT_ERROR);
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
