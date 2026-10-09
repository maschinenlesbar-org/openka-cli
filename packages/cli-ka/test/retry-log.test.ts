// A retry is one WARN record of ka.http: HTTP 503 from host: retry 1 of 3 in 1 s.

import { deepStrictEqual, match, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { EXIT_OK, run } from "../src/run.js";
import { retryMessage } from "../src/shared.js";
import { cliHarness } from "./harness.js";

const ARGV = ["sources", "count", "--source", "bund", "--api-key", "test-key"];
const okBody = JSON.stringify({ numFound: 0, documents: [] });

function flaky() {
  let calls = 0;
  return async () =>
    ++calls === 1
      ? { status: 503, headers: {}, body: Buffer.alloc(0) }
      : { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from(okBody) };
}

describe("a retry in the log", () => {
  it("is exactly one WARN record of ka.http, and stdout is unchanged", async () => {
    const plain = cliHarness({ transport: async () => ({ status: 200, headers: { "content-type": "application/json" }, body: Buffer.from(okBody) }) });
    const harness = cliHarness({ transport: flaky() });
    try {
      strictEqual(await run(ARGV, plain.deps), EXIT_OK);
      strictEqual(await run(ARGV, harness.deps), EXIT_OK);
      strictEqual(harness.stdout(), plain.stdout());
      const http = harness.stderr().split("\n").filter((line) => line.includes("[ka.http]"));
      strictEqual(http.length, 1);
      match(http[0] ?? "", /^WARN  \[ka\.http\] HTTP 503 from [^ :]+: retry 1 of 3 in 1 s$/);
    } finally {
      plain.cleanup();
      harness.cleanup();
    }
  });

  it("is one record in jsonl too", async () => {
    const harness = cliHarness({ transport: flaky() });
    try {
      strictEqual(await run(["--log-format", "jsonl", ...ARGV], harness.deps), EXIT_OK);
      const records = harness.err.map((line) => JSON.parse(line) as Record<string, unknown>).filter((r) => r["topic"] === "ka.http");
      deepStrictEqual(records.map((r) => [r["level"], r["topic"]]), [["WARN", "ka.http"]]);
    } finally {
      harness.cleanup();
    }
  });

  it("says ms under a second, and a reset connection", () => {
    strictEqual(retryMessage({ retry: 2, maxRetries: 3, delayMs: 250, status: 429, url: "https://a.example/x" }), "HTTP 429 from a.example: retry 2 of 3 in 250 ms");
    strictEqual(retryMessage({ retry: 1, maxRetries: 3, delayMs: 2000, url: "https://a.example/x" }), "connection reset from a.example: retry 1 of 3 in 2 s");
  });
});
