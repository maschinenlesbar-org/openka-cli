// The transport and the fetch engine: retry, redirects, conditional requests,
// rate limiting, and the http(s)-only rule at every layer.

import { deepStrictEqual, match, ok, rejects, strictEqual, throws } from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { describe, it } from "node:test";
import { MAX_TIMEOUT_MS, nodeHttpTransport } from "../src/http.js";
import {
  DEFAULT_USER_AGENT,
  FetchEngine,
  MAX_HOST_INTERVAL_MS,
  MAX_REDIRECTS,
  MAX_RETRIES,
  MIN_RESPONSE_BYTES,
  assertHttpScheme,
  retryDelayMs,
  sanitizeServerText,
  userAgentProblem,
} from "../src/engine.js";
import { buildQuery } from "../src/query.js";
import { NetworkError, OpenKaApiError, OpenKaValidationError } from "@maschinenlesbar.org/openka-lib-errors";
import { scriptedTransport, testEngine } from "@maschinenlesbar.org/openka-lib-testing";

describe("query builder", () => {
  it("sorts keys so identical params give identical URLs", () => {
    strictEqual(buildQuery({ b: 2, a: 1 }), "a=1&b=2");
  });

  it("repeats a key for an array and skips null/undefined", () => {
    strictEqual(buildQuery({ f: ["x", "y"], skip: undefined, none: null }), "f=x&f=y");
  });

  it("encodes reserved characters", () => {
    strictEqual(buildQuery({ "f.titel": "Klima & Schutz" }), "f.titel=Klima%20%26%20Schutz");
  });
});

describe("scheme checks", () => {
  it("accepts http and https and rejects anything else", () => {
    assertHttpScheme("https://example.invalid");
    assertHttpScheme("http://example.invalid");
    throws(() => assertHttpScheme("file:///etc/passwd"), NetworkError);
    throws(() => assertHttpScheme("not a url"), NetworkError);
  });

  it("is enforced by the default transport too", async () => {
    await rejects(() => nodeHttpTransport({ method: "GET", url: "file:///etc/passwd" }), /Unsupported protocol/);
  });
});

describe("sanitising upstream text", () => {
  it("strips the control characters a terminal would act on", () => {
    strictEqual(sanitizeServerText("a\u001b[31mred\u009b0m"), "a [31mred 0m");
  });
});

describe("retry timing", () => {
  it("honours a numeric Retry-After", () => {
    strictEqual(retryDelayMs("2", 0), 2000);
  });

  it("reads only delay-seconds and an IMF-fixdate, and backs off on anything else", () => {
    // "-5" was the year −5 to Date.parse, so "retry immediately"; "0x10" was 16 s.
    for (const bad of ["-5", "0x10", "1e9", "1.5", "+3", "2026-01-01", "Thursday, 01-Jan-26 00:00:00 GMT"]) {
      strictEqual(retryDelayMs(bad, 1), 2000, bad);
    }
    const inTenSeconds = new Date(Date.now() + 10_000).toUTCString();
    const delay = retryDelayMs(inTenSeconds, 0);
    ok(delay > 8000 && delay <= 10_000, `${inTenSeconds} -> ${delay}`);
    strictEqual(retryDelayMs(new Date(Date.now() - 60_000).toUTCString(), 0), 0);
  });

  it("caps a huge Retry-After", () => {
    strictEqual(retryDelayMs("100000", 0), 60_000);
  });

  it("backs off linearly without a header", () => {
    strictEqual(retryDelayMs(undefined, 0), 1000);
    strictEqual(retryDelayMs(undefined, 2), 3000);
    // A blank header is no header. `Number("")` is 0, so an empty Retry-After
    // used to mean "retry now" and switched the backoff off for every attempt.
    strictEqual(retryDelayMs("", 0), 1000);
    strictEqual(retryDelayMs("   ", 2), 3000);
  });
});

describe("fetch engine", () => {
  it("builds URLs against a base and sorts the query", () => {
    const engine = new FetchEngine({ baseUrl: "https://example.invalid/" });
    strictEqual(engine.url("/api/v1/x", { b: 2, a: 1 }), "https://example.invalid/api/v1/x?a=1&b=2");
  });

  it("refuses an absolute URL with a non-http scheme", () => {
    const engine = new FetchEngine();
    throws(() => engine.url("ftp://example.invalid/x"), NetworkError);
  });

  it("returns the body of a 200", async () => {
    const { transport } = scriptedTransport([{ match: "ok", body: "hello" }]);
    const result = await testEngine(transport).get("https://example.invalid/ok");
    strictEqual(result.body.toString(), "hello");
    strictEqual(result.notModified, false);
  });

  it("throws a typed error for a non-2xx", async () => {
    const { transport } = scriptedTransport([{ match: "gone", status: 404, body: "no" }]);
    await rejects(() => testEngine(transport).get("https://example.invalid/gone"), OpenKaApiError);
  });

  it("retries a 503 and then succeeds", async () => {
    let calls = 0;
    const result = await testEngine(async (request) => {
      calls++;
      return calls === 1
        ? { status: 503, headers: { "retry-after": "1" }, body: Buffer.alloc(0) }
        : { status: 200, headers: {}, body: Buffer.from(`ok ${request.method}`) };
    }).get("https://example.invalid/flaky");
    strictEqual(calls, 2);
    strictEqual(result.body.toString(), "ok GET");
  });

  it("gives up after maxRetries", async () => {
    let calls = 0;
    const engine = testEngine(async () => {
      calls++;
      return { status: 503, headers: {}, body: Buffer.alloc(0) };
    }, { maxRetries: 2 });
    await rejects(() => engine.get("https://example.invalid/always"), OpenKaApiError);
    strictEqual(calls, 3);
  });

  it("does not retry what would fail the same way again, and retries a timeout once", async () => {
    // Every thrown error used to be retried maxRetries (3) times: an over-cap body
    // was downloaded four times, a hanging host cost four timeouts plus backoff.
    const callsFor = async (failure: NetworkError["failure"]): Promise<number> => {
      let calls = 0;
      const engine = testEngine(async () => {
        calls++;
        throw new NetworkError(`failed (${failure ?? "reset"})`, failure === undefined ? undefined : { failure });
      });
      await rejects(() => engine.get("https://example.invalid/x"), NetworkError);
      return calls;
    };
    strictEqual(await callsFor("too_large"), 1);
    strictEqual(await callsFor("bad_url"), 1);
    strictEqual(await callsFor("timeout"), 2);
    // A dropped connection is still worth the full retry budget.
    strictEqual(await callsFor(undefined), 4);
  });

  it("marks the transport's own size and deadline failures so the engine can tell", async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200);
      response.end(Buffer.alloc(4096, 0x41));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as { port: number };
    try {
      const error = await nodeHttpTransport({ method: "GET", url: `http://127.0.0.1:${port}/`, headers: {}, maxResponseBytes: 1024 }).then(
        () => undefined,
        (err: unknown) => err,
      );
      ok(error instanceof NetworkError);
      strictEqual(error.failure, "too_large");
      const bad = await nodeHttpTransport({ method: "GET", url: "ftp://example.invalid/", headers: {} }).catch((err: unknown) => err);
      strictEqual((bad as NetworkError).failure, "bad_url");
    } finally {
      server.close();
    }
  });

  it("reports a 304 as not-modified rather than an error", async () => {
    const { transport } = scriptedTransport([{ match: "cached", status: 304, headers: { etag: '"v2"' } }]);
    const result = await testEngine(transport).get("https://example.invalid/cached", {
      validators: { etag: '"v1"' },
    });
    strictEqual(result.notModified, true);
    strictEqual(result.etag, '"v2"');
  });

  it("sends the conditional-request headers it was given", async () => {
    const { transport, requests } = scriptedTransport([{ match: "cond", body: "x" }]);
    await testEngine(transport).get("https://example.invalid/cond", {
      validators: { etag: '"v1"', last_modified: "Mon, 21 Sep 2026 12:00:00 GMT" },
    });
    strictEqual(requests[0]?.headers?.["if-none-match"], '"v1"');
    strictEqual(requests[0]?.headers?.["if-modified-since"], "Mon, 21 Sep 2026 12:00:00 GMT");
  });

  it("follows a redirect on the same host, keeping headers", async () => {
    const { transport, requests } = scriptedTransport([
      { match: "/from", status: 302, headers: { location: "https://example.invalid/to" } },
      { match: "/to", body: "arrived" },
    ]);
    const result = await testEngine(transport).get("https://example.invalid/from", {
      headers: { authorization: "ApiKey secret" },
    });
    strictEqual(result.body.toString(), "arrived");
    strictEqual(requests[1]?.headers?.["authorization"], "ApiKey secret");
    strictEqual(result.finalUrl, "https://example.invalid/to");
  });

  it("follows a 303 (and a 301/302) to a POST with a GET and no body", async () => {
    // A STARWEB servlet may answer a form POST with a redirect to the results
    // page. Re-POSTing the form there is answered with the search form again.
    for (const status of [301, 302, 303]) {
      const { transport, requests } = scriptedTransport([
        { match: "/search", status, headers: { location: "https://example.invalid/results" } },
        { match: "/results", body: "hits" },
      ]);
      const result = await testEngine(transport).post("https://example.invalid/search", { body: "q=1" });
      strictEqual(result.body.toString(), "hits", String(status));
      strictEqual(requests[1]?.method, "GET", String(status));
      strictEqual(requests[1]?.body, undefined, String(status));
      strictEqual(requests[1]?.headers?.["content-type"], undefined, String(status));
    }
  });

  it("keeps the method and body across a 307 and a 308", async () => {
    for (const status of [307, 308]) {
      const { transport, requests } = scriptedTransport([
        { match: "/search", status, headers: { location: "https://example.invalid/results" } },
        { match: "/results", body: "hits" },
      ]);
      await testEngine(transport).post("https://example.invalid/search", { body: "q=1" });
      strictEqual(requests[1]?.method, "POST", String(status));
      strictEqual(requests[1]?.body, "q=1", String(status));
      match(requests[1]?.headers?.["content-type"] ?? "", /x-www-form-urlencoded/, String(status));
    }
  });

  it("strips credentials when a redirect crosses hosts", async () => {
    const { transport, requests } = scriptedTransport([
      { match: "origin.invalid", status: 302, headers: { location: "https://elsewhere.invalid/x" } },
      { match: "elsewhere.invalid", body: "arrived" },
    ]);
    await testEngine(transport).get("https://origin.invalid/from", {
      headers: { authorization: "ApiKey secret", cookie: "session=1", "x-api-key": "k" },
    });
    const forwarded = requests[1]?.headers ?? {};
    strictEqual(forwarded["authorization"], undefined);
    strictEqual(forwarded["cookie"], undefined);
    strictEqual(forwarded["x-api-key"], undefined);
    ok(forwarded["user-agent"] !== undefined);
  });

  it("strips credentials when a redirect downgrades https to http on the same host", async () => {
    const { transport, requests } = scriptedTransport([
      { match: "https://example.invalid/from", status: 302, headers: { location: "http://example.invalid/to" } },
      { match: "http://example.invalid/to", body: "arrived" },
    ]);
    await testEngine(transport).get("https://example.invalid/from", {
      headers: { authorization: "ApiKey secret", cookie: "session=1", "x-api-key": "k" },
    });
    const forwarded = requests[1]?.headers ?? {};
    strictEqual(forwarded["authorization"], undefined);
    strictEqual(forwarded["cookie"], undefined);
    strictEqual(forwarded["x-api-key"], undefined);
    ok(forwarded["user-agent"] !== undefined);
  });

  it("refuses to follow a redirect to a non-http scheme", async () => {
    const { transport } = scriptedTransport([
      { match: "/evil", status: 302, headers: { location: "file:///etc/passwd" } },
    ]);
    await rejects(() => testEngine(transport).get("https://example.invalid/evil"), NetworkError);
  });

  it("stops after maxRedirects", async () => {
    const { transport } = scriptedTransport([
      { match: "example.invalid", status: 302, headers: { location: "https://example.invalid/loop" } },
    ]);
    await rejects(
      () => testEngine(transport, { maxRedirects: 2 }).get("https://example.invalid/loop"),
      /Too many redirects/,
    );
  });

  it("surfaces a 3xx as an error when redirects are disabled", async () => {
    const { transport } = scriptedTransport([
      { match: "/x", status: 301, headers: { location: "https://example.invalid/y" } },
    ]);
    await rejects(() => testEngine(transport, { maxRedirects: 0 }).get("https://example.invalid/x"), /Too many redirects/);
  });

  it("keeps a minimum interval between two requests to the same host", async () => {
    const slept: number[] = [];
    const { transport } = scriptedTransport([{ match: "example.invalid", body: "x" }]);
    let clock = 0;
    const engine = new FetchEngine({
      transport,
      minHostIntervalMs: 500,
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
    });
    await engine.get("https://example.invalid/a");
    await engine.get("https://example.invalid/b");
    deepStrictEqual(slept, [500]);
  });

  it("identifies itself with a contact URL by default", async () => {
    const { transport, requests } = scriptedTransport([{ match: "ua", body: "x" }]);
    await testEngine(transport).get("https://example.invalid/ua");
    match(requests[0]?.headers?.["user-agent"] ?? "", /openka-cli \(\+https:\/\//);
  });
});

describe("the default transport against a real socket", () => {
  it("fetches, caps the body size and times out", async () => {
    const server = http.createServer((request, response) => {
      if (request.url === "/big") {
        response.writeHead(200);
        response.end("x".repeat(5000));
        return;
      }
      if (request.url === "/slow") {
        // Never respond; the request must hit its deadline.
        return;
      }
      response.writeHead(200, { "content-type": "text/plain", etag: '"v1"' });
      response.end("hello");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;

    try {
      const ok200 = await nodeHttpTransport({ method: "GET", url: `${base}/plain` });
      strictEqual(ok200.status, 200);
      strictEqual(ok200.body.toString(), "hello");
      strictEqual(ok200.headers["etag"], '"v1"');

      await rejects(
        () => nodeHttpTransport({ method: "GET", url: `${base}/big`, maxResponseBytes: 100 }),
        /exceeded maxResponseBytes/,
      );

      await rejects(() => nodeHttpTransport({ method: "GET", url: `${base}/slow`, timeoutMs: 50 }), NetworkError);
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("caps a timeout at the longest delay Node's timers support", () => {
    ok(MAX_TIMEOUT_MS === 2_147_483_647);
  });
});

describe("engine options", () => {
  it("names its bounds", () => {
    deepStrictEqual(
      [MAX_RETRIES, MAX_REDIRECTS, MAX_HOST_INTERVAL_MS, MIN_RESPONSE_BYTES],
      [10, 10, 60_000, 1024],
    );
  });

  it("refuses an option out of range, fractional or not finite, before any request", () => {
    const calls: unknown[] = [];
    const transport = async (request: unknown) => {
      calls.push(request);
      return { status: 200, headers: {}, body: Buffer.alloc(0) };
    };
    for (const [option, value, reason] of [
      ["maxRetries", -1, "Must be >= 0."],
      ["maxRetries", 1.5, "Expected an integer."],
      ["maxRetries", 11, "Must be <= 10."],
      ["maxRedirects", Number.NaN, "Expected an integer."],
      ["maxRedirects", 11, "Must be <= 10."],
      ["maxResponseBytes", 1023, "Must be >= 1024."],
      ["maxResponseBytes", Number.POSITIVE_INFINITY, "Expected an integer."],
      ["minHostIntervalMs", -1, "Must be >= 0."],
      ["timeoutMs", MAX_TIMEOUT_MS + 1, `Must be <= ${MAX_TIMEOUT_MS}.`],
      ["timeoutMs", -1, "Must be >= 0."],
    ] as const) {
      throws(
        () => new FetchEngine({ transport, [option]: value }),
        (error: unknown) => error instanceof OpenKaValidationError && error.message === `Invalid ${option}: ${reason}`,
        `${option} ${value}`,
      );
    }
    deepStrictEqual(calls, []);
  });

  it("refuses a User-Agent that is blank or not a header value", () => {
    strictEqual(userAgentProblem("openka-test/1.0 (+https://example.invalid; é)"), undefined);
    strictEqual(userAgentProblem("a\tb"), undefined);
    for (const blank of ["", "  "]) strictEqual(userAgentProblem(blank), "Expected a non-empty value.");
    for (const bad of ["a\r\nb", "a\u0000b", "a\u007fb", "a€"]) {
      strictEqual(userAgentProblem(bad), "Expected a header value: no control characters, nothing above U+00FF.");
      throws(() => new FetchEngine({ userAgent: bad }), OpenKaValidationError);
    }
  });

  it("accepts the bounds and keeps its defaults when nothing is set", () => {
    const engine = new FetchEngine({ maxRetries: 0, maxRedirects: 0, timeoutMs: 0, minHostIntervalMs: 0, maxResponseBytes: Number.MAX_SAFE_INTEGER });
    strictEqual(engine.userAgent, DEFAULT_USER_AGENT);
    strictEqual(new FetchEngine({ maxRetries: MAX_RETRIES, maxRedirects: MAX_REDIRECTS, timeoutMs: MAX_TIMEOUT_MS, minHostIntervalMs: MAX_HOST_INTERVAL_MS }).userAgent, DEFAULT_USER_AGENT);
  });
});
