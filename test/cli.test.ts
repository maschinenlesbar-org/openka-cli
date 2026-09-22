// The CLI, driven in-process through `run()` with a real temporary corpus, a
// scripted transport and a fixed clock. No subprocess, no network.

import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { EXIT_ERROR, EXIT_OK, EXIT_STORE, EXIT_USAGE, run } from "../src/cli/run.js";
import { runFactory } from "../src/factory/cli/run.js";
import { defaultCorpusRoot, parseIsoDate, parseBoundedInt, parseNonEmpty } from "../src/cli/shared.js";
import { escapeControlChars, sanitizeForTerminal, truncate } from "../src/cli/text.js";
import { spread } from "../src/cli/commands/maintain.js";
import { cliHarness, readFixture, readFixtureText, scriptedTransport } from "./helpers.js";

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

  it("resolves the corpus root from the environment", () => {
    match(defaultCorpusRoot({ OPENKA_CORPUS: "/tmp/x" }), /\/tmp\/x$/);
    match(defaultCorpusRoot({ XDG_DATA_HOME: "/tmp/share" }), /\/tmp\/share\/openka$/);
    match(defaultCorpusRoot({}), /\.local\/share\/openka$/);
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

  it("refuses to sync a source that needs a credential it does not have", async () => {
    const harness = cliHarness({ transport: berlinTransport().transport });
    strictEqual(await run(["--corpus", harness.corpus, "sync", "--source", "bund"], harness.deps), EXIT_ERROR);
    match(harness.stderr(), /needs a key/);
    harness.cleanup();
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

  it("reports an unreadable corpus with its own exit code", async () => {
    const harness = cliHarness();
    // A record id that would escape the records directory is a store error.
    strictEqual(await run(["--corpus", harness.corpus, "show", "../etc/passwd"], harness.deps), EXIT_STORE);
    harness.cleanup();
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
    match(harness.stdout(), /No generative-model dependency on the line/);
    harness.cleanup();
  });

  it("samples across the corpus rather than one alphabetical prefix", () => {
    // Record ids sort by parliament, so `slice(0, n)` checked the same first
    // records every run and whole Länder were never verified.
    const ids = [
      ...Array.from({ length: 15 }, (_, i) => `berlin-19-${i}`),
      ...Array.from({ length: 15 }, (_, i) => `sachsen-8-${i}`),
      ...Array.from({ length: 15 }, (_, i) => `thueringen-8-${i}`),
    ];
    const sample = spread(ids, 25);
    strictEqual(sample.length, 25);
    for (const parliament of ["berlin", "sachsen", "thueringen"]) {
      ok(sample.some((id: string) => id.startsWith(parliament)), `${parliament} missing from the sample`);
    }
    // Deterministic: a reproducibility check must pick the same records each run.
    deepStrictEqual(spread(ids, 25), sample);
    deepStrictEqual(spread(ids, 100), ids);
  });

  it("verifies the committed goldens", async () => {
    const harness = cliHarness();
    strictEqual(await runFactory(["goldens", "verify", "--dir", "fixtures"], harness.deps), EXIT_OK);
    match(harness.stdout(), /(\d+)\/\1 golden\(s\) reproduced/);
    harness.cleanup();
  });

  it("lists the goldens with their notes", async () => {
    const harness = cliHarness();
    strictEqual(await runFactory(["goldens", "list", "--dir", "fixtures"], harness.deps), EXIT_OK);
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

  it("reports a corpus with no baseline as new rather than broken", async () => {
    const harness = await seeded();
    try {
      strictEqual(
        await runFactory(["--corpus", harness.corpus, "drift", "--baseline", `${harness.corpus}/none.json`], harness.deps),
        EXIT_OK,
      );
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
