// The transport and the fetch engine: retry, redirects, conditional requests,
// rate limiting, and the http(s)-only rule at every layer.

import { deepStrictEqual, match, ok, rejects, strictEqual, throws } from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { describe, it } from "node:test";
import { MAX_TIMEOUT_MS, nodeHttpTransport } from "../src/http.js";
import { FetchEngine, assertHttpScheme, retryDelayMs, sanitizeServerText } from "../src/engine.js";
import { buildQuery } from "../src/query.js";
import { NetworkError, OpenKaApiError } from "@maschinenlesbar.org/openka-lib-errors";
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
