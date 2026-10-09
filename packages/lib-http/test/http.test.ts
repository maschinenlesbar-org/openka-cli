// The transport and the fetch engine: retry, redirects, conditional requests,
// rate limiting, and the http(s)-only rule at every layer.

import { deepStrictEqual, match, ok, rejects, strictEqual, throws } from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, it } from "node:test";
import { MAX_TIMEOUT_MS, nodeHttpTransport } from "../src/http.js";
import {
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_USER_AGENT,
  FetchEngine,
  HostPacer,
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

  it("takes fewer retries for one request when asked, never more", async () => {
    let calls = 0;
    const engine = testEngine(async () => {
      calls++;
      return { status: 503, headers: {}, body: Buffer.alloc(0) };
    }, { maxRetries: 2 });
    await rejects(() => engine.get("https://example.invalid/robots.txt", { maxRetries: 1 }), OpenKaApiError);
    strictEqual(calls, 2);
    calls = 0;
    await rejects(() => engine.get("https://example.invalid/robots.txt", { maxRetries: 9 }), OpenKaApiError);
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

  it("says a string that is not an absolute URL is not a URL, rather than that no base URL is configured", async () => {
    const engine = testEngine(async () => {
      throw new Error("no request should be made");
    });
    for (const bad of ["ht tp://bad host", "/dokument.pdf", "dokument.pdf"]) {
      const error = await engine.get(bad).catch((err: unknown) => err);
      ok(error instanceof NetworkError, bad);
      match(error.message, /^Invalid URL \(not absolute, and no base URL is configured\): /, bad);
      ok(error.message.includes(bad), bad);
      strictEqual(error.failure, "bad_url", bad);
    }
    // With a base URL a relative path is still resolved against it.
    strictEqual(new FetchEngine({ baseUrl: "https://example.invalid/api/", transport: async () => ({ status: 200, headers: {}, body: Buffer.alloc(0) }) }).url("/x"), "https://example.invalid/api/x");
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

  it("refuses a body that declares more than the cap before reading it, and names its size — but not a HEAD's", async () => {
    // Issue #23: what the caller needs to fetch it is the document's own size.
    strictEqual(DEFAULT_MAX_RESPONSE_BYTES, 128 * 1024 * 1024);
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { "content-length": "4096" });
      response.end(_request.method === "HEAD" ? undefined : Buffer.alloc(4096, 0x41));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as { port: number };
    try {
      const url = `http://127.0.0.1:${port}/`;
      const error = await nodeHttpTransport({ method: "GET", url, headers: {}, maxResponseBytes: 1024 }).then(() => undefined, (err: unknown) => err);
      ok(error instanceof NetworkError);
      deepStrictEqual([error.failure, error.bytes, error.message], ["too_large", 4096, "Response of 4096 bytes exceeds maxResponseBytes (1024)"]);
      strictEqual((await nodeHttpTransport({ method: "HEAD", url, headers: {}, maxResponseBytes: 1024 })).status, 200);
    } finally {
      server.close();
    }
  });

  it("counts where its time went: requests, retries, 429/503 answers, upstream time and waiting", async () => {
    // Issue #14: a slow sync could not tell the upstream from the pacing from extraction.
    let t = 0;
    let calls = 0;
    const engine = new FetchEngine({
      minHostIntervalMs: 1000,
      maxRetries: 2,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      transport: async () => {
        t += 300;
        calls++;
        return calls === 1
          ? { status: 503, headers: { "retry-after": "2" }, body: Buffer.alloc(0) }
          : { status: 200, headers: {}, body: Buffer.from("ok") };
      },
    });
    await engine.get("https://example.invalid/a");
    // The 503 waited its Retry-After (2 s), past the 1 s interval: no pacing wait on top.
    deepStrictEqual({ ...engine.metrics, durations: [...engine.metrics.durations] }, {
      requests: 2,
      retries: 1,
      throttled: 1,
      retryReasons: { throttled: 1, timeout: 0, connection: 0, other: 0 },
      reconnects: 0,
      upstreamMs: 600,
      durations: [300, 300],
      waitMs: 2000,
    });
    await engine.get("https://example.invalid/b");
    // The second request waited for the host's interval: 1000 ms after the last, 300 ms of it gone.
    deepStrictEqual([engine.metrics.requests, engine.metrics.waitMs], [3, 2700]);
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

  it("asks onRedirect about every hop before requesting it, and stops when it throws", async () => {
    const { transport, requests } = scriptedTransport([
      { match: "/a", status: 302, headers: { location: "/b" } },
      { match: "/b", status: 302, headers: { location: "https://other.invalid/c" } },
      { match: "/c", body: "arrived" },
    ]);
    const asked: string[] = [];
    const result = await testEngine(transport).get("https://example.invalid/a", { onRedirect: (url) => void asked.push(url) });
    strictEqual(result.body.toString(), "arrived");
    deepStrictEqual(asked, ["https://example.invalid/b", "https://other.invalid/c"]);
    const refused = scriptedTransport([
      { match: "/a", status: 302, headers: { location: "https://other.invalid/c" } },
      { match: "/c", body: "arrived" },
    ]);
    await rejects(
      () => testEngine(refused.transport).get("https://example.invalid/a", { onRedirect: () => { throw new Error("no"); } }),
      /no/,
    );
    ok(!refused.requests.some((request) => request.url.includes("other.invalid")));
    ok(requests.length === 3);
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

  it("refuses a redirect that downgrades https to http, so nothing — credentials included — goes out in clear", async () => {
    const { transport, requests } = scriptedTransport([
      { match: "https://example.invalid/from", status: 302, headers: { location: "http://example.invalid/to" } },
      { match: "http://example.invalid/to", body: "arrived" },
    ]);
    await rejects(
      () => testEngine(transport).get("https://example.invalid/from", { headers: { authorization: "ApiKey secret" } }),
      (err: unknown) => err instanceof NetworkError && /from https: to http:/.test(err.message),
    );
    strictEqual(requests.length, 1);
    // http → https (an upgrade) is still followed.
    const upgrade = scriptedTransport([
      { match: "http://example.invalid/from", status: 301, headers: { location: "https://example.invalid/to" } },
      { match: "https://example.invalid/to", body: "arrived" },
    ]);
    strictEqual((await testEngine(upgrade.transport).get("http://example.invalid/from")).body.toString(), "arrived");
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

  it("raises its engine-wide interval to a floor, and never lowers it", async () => {
    const slept: number[] = [];
    const { transport } = scriptedTransport([{ match: "example.invalid", body: "x" }]);
    let clock = 0;
    const engine = new FetchEngine({
      transport,
      minHostIntervalMs: 100,
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
    });
    engine.raiseMinHostInterval(4000);
    engine.raiseMinHostInterval(50);
    await engine.get("https://example.invalid/a");
    await engine.get("https://example.invalid/b");
    // Every host, not only one named in advance: a source's floor covers the
    // aggregator and the document server alike.
    await engine.get("https://other.example.invalid/a");
    await engine.get("https://other.example.invalid/b");
    deepStrictEqual(slept, [4000, 4000]);
  });

  it("refuses a floor out of range, the same way the option is refused", () => {
    const engine = new FetchEngine({});
    for (const [value, reason] of [
      [-1, "Must be >= 0."],
      [1.5, "Expected an integer."],
      [Number.NaN, "Expected an integer."],
      [MAX_HOST_INTERVAL_MS + 1, `Must be <= ${MAX_HOST_INTERVAL_MS}.`],
    ] as const) {
      throws(
        () => engine.raiseMinHostInterval(value),
        (error: unknown) => error instanceof OpenKaValidationError && error.message === `Invalid minHostIntervalMs: ${reason}`,
        String(value),
      );
    }
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

describe("pacing shared between engines (issue #3)", () => {
  /** A clock whose sleeps advance it, and a log of when each host was asked. */
  function pacedWorld(): { now: () => number; sleep: (ms: number) => Promise<void>; asked: [string, number][]; transport: Parameters<typeof testEngine>[0] } {
    let clock = 0;
    const asked: [string, number][] = [];
    const { transport } = scriptedTransport([{ match: "example.invalid", body: "x" }]);
    return {
      now: () => clock,
      sleep: async (ms) => {
        // Real timers interleave concurrent sleepers; yielding first lets the other
        // engine's request queue up before this one's clock moves.
        await new Promise((resolve) => setImmediate(resolve));
        clock += ms;
      },
      asked,
      transport: async (request) => {
        asked.push([new URL(request.url).host, clock]);
        return transport(request);
      },
    };
  }

  it("never asks one host twice within the interval, whichever engine asks", async () => {
    const world = pacedWorld();
    const pacer = new HostPacer();
    const engine = (ms: number): FetchEngine =>
      new FetchEngine({ transport: world.transport, minHostIntervalMs: ms, now: world.now, sleep: world.sleep, pacer });
    const a = engine(500);
    const b = engine(500);
    await Promise.all([
      (async () => {
        for (const path of ["a1", "a2", "a3"]) await a.get(`https://shared.example.invalid/${path}`);
      })(),
      (async () => {
        for (const path of ["b1", "b2", "b3"]) await b.get(`https://shared.example.invalid/${path}`);
      })(),
    ]);
    const times = world.asked.map(([, at]) => at);
    strictEqual(times.length, 6);
    for (let i = 1; i < times.length; i++) ok((times[i] ?? 0) - (times[i - 1] ?? 0) >= 500, `gap ${i}: ${times.join(", ")}`);
  });

  it("paces only a shared host together: other hosts keep their own pace", async () => {
    const world = pacedWorld();
    const pacer = new HostPacer();
    const a = new FetchEngine({ transport: world.transport, minHostIntervalMs: 500, now: world.now, sleep: world.sleep, pacer });
    const b = new FetchEngine({ transport: world.transport, minHostIntervalMs: 500, now: world.now, sleep: world.sleep, pacer });
    await Promise.all([a.get("https://one.example.invalid/x"), b.get("https://two.example.invalid/x")]);
    deepStrictEqual(world.asked.map(([, at]) => at), [0, 0]);
  });

  it("holds a host one engine slowed down for every engine on the pacer", async () => {
    // A source run under --ignore-robots slows the host to 4 s; the next source of
    // the same run asked it 500 ms later.
    const world = pacedWorld();
    const pacer = new HostPacer();
    const a = new FetchEngine({ transport: world.transport, minHostIntervalMs: 500, now: world.now, sleep: world.sleep, pacer });
    const b = new FetchEngine({ transport: world.transport, minHostIntervalMs: 500, now: world.now, sleep: world.sleep, pacer });
    a.slowDown("shared.example.invalid", 4000);
    await a.get("https://shared.example.invalid/a");
    await b.get("https://shared.example.invalid/b");
    deepStrictEqual(world.asked.map(([, at]) => at), [0, 4000]);
  });

  it("keeps engines without a shared pacer independent, as before", async () => {
    const world = pacedWorld();
    const a = new FetchEngine({ transport: world.transport, minHostIntervalMs: 500, now: world.now, sleep: world.sleep });
    const b = new FetchEngine({ transport: world.transport, minHostIntervalMs: 500, now: world.now, sleep: world.sleep });
    await a.get("https://shared.example.invalid/a");
    await b.get("https://shared.example.invalid/b");
    deepStrictEqual(world.asked.map(([, at]) => at), [0, 0]);
  });
});

describe("a kept-alive connection the server has closed (issue #31)", () => {
  /** A test that starts a server process: process start is real work, so it gets 30 s. */
  const STARTS_A_PROCESS = { timeout: 30_000 };

  it("sends a GET again on a new connection when the reused one fails before any answer, and not a POST", async () => {
    // Answers the first request on each connection and drops the second, as a server
    // does that closed the connection while the client was busy.
    const server = net.createServer((socket) => {
      let requests = 0;
      socket.on("data", () => {
        if (++requests === 1) socket.write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: keep-alive\r\nKeep-Alive: timeout=5\r\n\r\nok");
        else socket.destroy();
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));
    try {
      strictEqual((await nodeHttpTransport({ method: "GET", url })).reconnected, undefined);
      await pause(); // the connection is back in the pool
      const again = await nodeHttpTransport({ method: "GET", url });
      deepStrictEqual([again.status, again.body.toString(), again.reconnected], [200, "ok", true]);
      await nodeHttpTransport({ method: "GET", url });
      await pause();
      await rejects(() => nodeHttpTransport({ method: "POST", url, body: "x" }), NetworkError);
    } finally {
      server.close();
    }
  });

  it("does not hand out a connection the server closed while the event loop was busy", STARTS_A_PROCESS, async () => {
    // The server in a process of its own, so blocking this one does not hold its timer.
    const child = spawn(process.execPath, [
      "-e",
      `const http = require("node:http");
       const server = http.createServer((req, res) => { res.setHeader("Keep-Alive", "timeout=5"); res.end("ok"); });
       server.keepAliveTimeout = 100;
       server.keepAliveTimeoutBuffer = 0;
       server.listen(0, "127.0.0.1", () => console.log(server.address().port));`,
    ], { stdio: ["ignore", "pipe", "inherit"] });
    try {
      const [data] = (await once(child.stdout, "data")) as [Buffer];
      const url = `http://127.0.0.1:${Number(String(data).trim())}/`;
      await nodeHttpTransport({ method: "GET", url });
      await new Promise((resolve) => setTimeout(resolve, 20));
      // A sync storing a record: the server closes the idle connection meanwhile.
      const until = Date.now() + 600;
      while (Date.now() < until) {
        /* busy */
      }
      const next = await nodeHttpTransport({ method: "GET", url });
      deepStrictEqual([next.status, next.reconnected], [200, undefined], "the closed connection was not used at all");
    } finally {
      child.kill();
    }
  });

  it("counts reconnects apart from retries, and retries by reason", async () => {
    const calls: string[] = [];
    const engine = testEngine(async (request) => {
      calls.push(request.url);
      if (calls.length === 1) throw new NetworkError("read ECONNRESET", { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });
      if (calls.length === 2) throw new NetworkError("Request timed out after 5ms", { failure: "timeout" });
      if (calls.length === 3) return { status: 503, headers: {}, body: Buffer.alloc(0) };
      return { status: 200, headers: {}, body: Buffer.from("ok"), reconnected: true };
    });
    await engine.get("https://example.invalid/x");
    deepStrictEqual(
      [engine.metrics.retries, engine.metrics.retryReasons, engine.metrics.reconnects],
      [3, { throttled: 1, timeout: 1, connection: 1, other: 0 }, 1],
    );
  });
});
