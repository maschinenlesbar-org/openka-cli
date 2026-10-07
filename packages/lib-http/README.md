# @maschinenlesbar.org/openka-lib-http

> Every HTTP request the project makes, and the rules it makes them under.

Built on Node's built-in `http`/`https` — no axios, no fetch polyfill, no
third-party client. The transport is a plain function, so tests inject a canned
responder instead of touching the network; the default implementation is exercised
against a local `http.createServer`.

The engine is the one place "being a good citizen" lives: retry with backoff that
honours `Retry-After`, conditional requests via ETag/If-Modified-Since, a response
size ceiling, per-host rate limiting, and redirect handling that strips credential
headers on a cross-origin hop, refuses an https: → http: downgrade, and asks the
caller's `onRedirect` hook (the pipeline's robots.txt check) about every hop. Doing it
once here means no adapter has to remember any of it.

**What is retried.** A 429/503 and a dropped connection get the full `maxRetries`;
a timeout is retried once (`timeoutMs` is per attempt); a response over
`maxResponseBytes` or a URL that cannot be fetched is not retried at all, because it
would fail the same way at the same cost. The transport says which it was through
`NetworkError.failure`.

`--base-url` is trusted input but only `http:` and `https:` are accepted, checked at
parse time, in the engine, and again per hop.

**What the constructor refuses.** `new FetchEngine(options)` runs
`assertEngineOptions` first and throws `OpenKaValidationError` for `timeoutMs`
outside 0–`MAX_TIMEOUT_MS`, `maxRetries` outside 0–`MAX_RETRIES`, `maxRedirects`
outside 0–`MAX_REDIRECTS`, `minHostIntervalMs` outside 0–`MAX_HOST_INTERVAL_MS`,
`maxResponseBytes` below `MIN_RESPONSE_BYTES` (all integers), and a User-Agent that
is blank or not a header value (`userAgentProblem`). An omitted option keeps its
`DEFAULT_*`. `ka`'s global options use the same constants and rule.

**Raising the pace floor.** `engine.raiseMinHostInterval(ms)` raises the engine-wide
interval between two requests to one host and never lowers it; `slowDown(host, ms)`
does the same for one host. `sync()` calls the first with a source's politeness floor
(`Source.minHostIntervalMs`). A value the `minHostIntervalMs` option would refuse
throws `OpenKaValidationError`.

**Pacing shared between engines.** The per-host book of when each host was last asked
is a `HostPacer`. An engine keeps its own unless `EngineOptions.pacer` hands it one to
share; engines that share one queue their requests to a host behind each other, and no
two of them reach it closer together than the interval of the one asking second.
`ka sync --source a --source b` builds one engine per source on one pacer, so two
sources that both reach the Parlamentsspiegel never ask it faster than one would. The
queue also spaces concurrent requests of one engine, which used to read the same "last
request" and go out together.

## What is in here

- **`src/engine.ts`** — The fetch engine: URL building, retry/backoff, redirects, conditional requests and per-host rate limiting.
- **`src/http.ts`** — HTTP transport built on Node's built-in `http`/`https` — no axios, no fetch polyfill, no third-party HTTP client.
- **`src/query.ts`** — A dependency-free query-string builder.

## Public surface

Everything is re-exported from the package root:

```
DEFAULT_USER_AGENT, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_RESPONSE_BYTES, DEFAULT_MAX_RETRIES, MAX_RETRIES, DEFAULT_MAX_REDIRECTS, MAX_REDIRECTS, DEFAULT_MIN_HOST_INTERVAL_MS, MAX_HOST_INTERVAL_MS, MIN_RESPONSE_BYTES, userAgentProblem, assertEngineOptions, EngineOptions, HostPacer, assertHttpScheme, sanitizeServerText, CacheValidators, FetchResult, FetchEngine, retryDelayMs, HttpRequest, HttpResponse, Transport, MAX_TIMEOUT_MS, nodeHttpTransport, QueryValue, QueryParams, buildQuery
```

## Depends on

- `lib-errors` — the shared error hierarchy
- `lib-text` — control-character stripping

## Tests

`test/http.test.ts` — run with:

```bash
npm test -w @maschinenlesbar.org/openka-lib-http
```
