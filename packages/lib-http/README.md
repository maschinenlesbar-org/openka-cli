# @maschinenlesbar.org/openka-lib-http

> Every HTTP request the project makes, and the rules it makes them under.

Built on Node's built-in `http`/`https` — no axios, no fetch polyfill, no
third-party client. The transport is a plain function, so tests inject a canned
responder instead of touching the network; the default implementation is exercised
against a local `http.createServer`.

The engine is the one place "being a good citizen" lives: retry with backoff that
honours `Retry-After`, conditional requests via ETag/If-Modified-Since, a response
size ceiling, per-host rate limiting, and redirect handling that strips credential
headers on a cross-origin hop. Doing it once here means no adapter has to remember
any of it.

`--base-url` is trusted input but only `http:` and `https:` are accepted, checked at
parse time, in the engine, and again per hop.

## What is in here

- **`src/engine.ts`** — The fetch engine: URL building, retry/backoff, redirects, conditional requests and per-host rate limiting.
- **`src/http.ts`** — HTTP transport built on Node's built-in `http`/`https` — no axios, no fetch polyfill, no third-party HTTP client.
- **`src/query.ts`** — A dependency-free query-string builder.

## Public surface

Everything is re-exported from the package root:

```
DEFAULT_USER_AGENT, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_RESPONSE_BYTES, EngineOptions, assertHttpScheme, sanitizeServerText, CacheValidators, FetchResult, FetchEngine, retryDelayMs, HttpRequest, HttpResponse, Transport, MAX_TIMEOUT_MS, nodeHttpTransport, QueryValue, QueryParams, buildQuery
```

## Depends on

- `lib-errors` — the shared error hierarchy
- `lib-text` — control-character stripping

## Tests

`test/http.test.ts` — run with:

```bash
npm test -w @maschinenlesbar.org/openka-lib-http
```
