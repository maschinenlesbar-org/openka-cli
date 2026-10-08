// HTTP transport built on Node's built-in `http`/`https` — no axios, no fetch
// polyfill, no third-party HTTP client. The transport is a plain function so tests
// inject a canned responder instead of touching the network; the default
// implementation is exercised against a local `http.createServer`.

import http from "node:http";
import https from "node:https";
import { NetworkError } from "@maschinenlesbar.org/openka-lib-errors";

export interface HttpRequest {
  method: string;
  /** Fully-qualified absolute URL. */
  url: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  timeoutMs?: number;
  /** Hard cap on the response body size in bytes; the request aborts if exceeded. */
  maxResponseBytes?: number;
}

export interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  /**
   * True when the request first went out on a kept-alive connection the server had
   * closed, and was sent again on a new one (`nodeHttpTransport`, issue #31).
   */
  reconnected?: true;
}

export type Transport = (request: HttpRequest) => Promise<HttpResponse>;

/**
 * The longest delay Node's timers support (2^31 - 1 ms, about 24.8 days). A longer
 * one prints a TimeoutOverflowWarning and fires after 1 ms, so timeouts are capped.
 */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/** Socket errors that mean the server had closed a kept-alive connection before the request reached it. */
const STALE_SOCKET_CODES = new Set(["ECONNRESET", "EPIPE", "ECONNABORTED"]);

/** Methods that may be sent twice: a request that never reached the server is sent again only for these. */
const IDEMPOTENT = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Default transport. Resolves with the raw response (including non-2xx) — status
 * interpretation is the engine's job. Rejects only on transport-level failures.
 *
 * Connections are kept alive between requests, and a server closes an idle one after
 * its own timeout (Apache: 5 s). The pool learns of that close only when the event loop
 * runs, and a sync stores a record synchronously between two requests. The next
 * request then went out on the dead socket and failed with ECONNRESET: 615 retries in
 * 1,481 requests to padoka, none of them the server's doing (issue #31). So the
 * transport first lets the event loop take a turn, and a request that still fails on a
 * reused socket before any response is sent once more on a new connection — not a
 * retry, since it never reached the server.
 */
export const nodeHttpTransport: Transport = async (request) => {
  // One turn of the event loop: a close the server sent while the loop was busy is
  // read now, and the pool drops that socket instead of handing it out.
  await new Promise<void>((resolve) => setImmediate(resolve));
  try {
    return await send(request, false);
  } catch (err) {
    if (!(err instanceof StaleSocketError)) throw err;
    if (!IDEMPOTENT.has(request.method.toUpperCase())) throw err.original;
    return { ...(await send(request, true)), reconnected: true };
  }
};

/** A request that failed on a reused socket before any response: the server had closed it. */
class StaleSocketError extends Error {
  constructor(readonly original: NetworkError) {
    super(original.message);
  }
}

function send(request: HttpRequest, fresh: boolean): Promise<HttpResponse> {
  return new Promise<HttpResponse>((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      reject(new NetworkError(`Invalid URL: ${request.url}`, { failure: "bad_url" }));
      return;
    }

    // Only http/https. Rejecting here keeps file:/ftp:/data: from ever reaching a
    // driver, including on a redirect hop the engine hands us.
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      reject(new NetworkError(`Unsupported protocol "${url.protocol}" in URL: ${request.url}`, { failure: "bad_url" }));
      return;
    }

    const driver = url.protocol === "https:" ? https : http;
    const maxBytes = request.maxResponseBytes;

    // Wall-clock deadline. `req.setTimeout` is only an *idle-socket* timer, so a
    // server trickling one byte per interval never idles out (slow loris). This
    // second timer bounds the whole request and is cleared on every terminal path.
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const clearDeadline = (): void => {
      if (deadline !== undefined) {
        clearTimeout(deadline);
        deadline = undefined;
      }
    };

    let responded = false;
    // `agent: false` is a connection of its own, closed after this request.
    const req = driver.request(url, { method: request.method, headers: request.headers, ...(fresh ? { agent: false } : {}) }, (res) => {
      responded = true;
      const chunks: Buffer[] = [];
      let received = 0;
      let aborted = false;

      // A body that says up front it will not fit is not downloaded to find out. A HEAD
      // answer declares the length of a body it does not send, so it is not one.
      const declared = Number(res.headers["content-length"]);
      if (request.method !== "HEAD" && maxBytes !== undefined && Number.isSafeInteger(declared) && declared > maxBytes) {
        clearDeadline();
        res.destroy();
        reject(new NetworkError(`Response of ${declared} bytes exceeds maxResponseBytes (${maxBytes})`, { failure: "too_large", bytes: declared }));
        return;
      }

      res.on("data", (chunk: Buffer) => {
        if (aborted) return;
        received += chunk.length;
        if (maxBytes !== undefined && received > maxBytes) {
          aborted = true;
          clearDeadline();
          res.destroy();
          reject(new NetworkError(`Response exceeded maxResponseBytes (${maxBytes})`, { failure: "too_large" }));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        if (aborted) return;
        clearDeadline();
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) });
      });
      res.on("error", (err) => {
        if (aborted) return;
        clearDeadline();
        reject(new NetworkError(`Response stream error: ${err.message}`, { cause: err }));
      });
    });

    if (request.timeoutMs && request.timeoutMs > 0) {
      const delay = Math.min(request.timeoutMs, MAX_TIMEOUT_MS);
      req.setTimeout(delay, () => {
        req.destroy(new NetworkError(`Request timed out after ${request.timeoutMs}ms`, { failure: "timeout" }));
      });
      deadline = setTimeout(() => {
        req.destroy(new NetworkError(`Request exceeded deadline of ${request.timeoutMs}ms`, { failure: "timeout" }));
      }, delay);
      deadline.unref?.();
    }

    req.on("error", (err) => {
      clearDeadline();
      const error = err instanceof NetworkError ? err : new NetworkError(err.message, { cause: err });
      const code = (err as { code?: unknown }).code;
      if (!fresh && !responded && req.reusedSocket && typeof code === "string" && STALE_SOCKET_CODES.has(code)) {
        reject(new StaleSocketError(error));
        return;
      }
      reject(error);
    });

    if (request.body !== undefined) req.write(request.body);
    req.end();
  });
}
