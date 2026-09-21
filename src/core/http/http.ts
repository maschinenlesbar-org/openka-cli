// HTTP transport built on Node's built-in `http`/`https` — no axios, no fetch
// polyfill, no third-party HTTP client. The transport is a plain function so tests
// inject a canned responder instead of touching the network; the default
// implementation is exercised against a local `http.createServer`.

import http from "node:http";
import https from "node:https";
import { NetworkError } from "../errors.js";

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
}

export type Transport = (request: HttpRequest) => Promise<HttpResponse>;

/**
 * The longest delay Node's timers support (2^31 - 1 ms, about 24.8 days). A longer
 * one prints a TimeoutOverflowWarning and fires after 1 ms, so timeouts are capped.
 */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Default transport. Resolves with the raw response (including non-2xx) — status
 * interpretation is the engine's job. Rejects only on transport-level failures.
 */
export const nodeHttpTransport: Transport = (request) =>
  new Promise<HttpResponse>((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      reject(new NetworkError(`Invalid URL: ${request.url}`));
      return;
    }

    // Only http/https. Rejecting here keeps file:/ftp:/data: from ever reaching a
    // driver, including on a redirect hop the engine hands us.
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      reject(new NetworkError(`Unsupported protocol "${url.protocol}" in URL: ${request.url}`));
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

    const req = driver.request(url, { method: request.method, headers: request.headers }, (res) => {
      const chunks: Buffer[] = [];
      let received = 0;
      let aborted = false;

      res.on("data", (chunk: Buffer) => {
        if (aborted) return;
        received += chunk.length;
        if (maxBytes !== undefined && received > maxBytes) {
          aborted = true;
          clearDeadline();
          res.destroy();
          reject(new NetworkError(`Response exceeded maxResponseBytes (${maxBytes})`));
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
        req.destroy(new NetworkError(`Request timed out after ${request.timeoutMs}ms`));
      });
      deadline = setTimeout(() => {
        req.destroy(new NetworkError(`Request exceeded deadline of ${request.timeoutMs}ms`));
      }, delay);
      deadline.unref?.();
    }

    req.on("error", (err) => {
      clearDeadline();
      reject(err instanceof NetworkError ? err : new NetworkError(err.message, { cause: err }));
    });

    if (request.body !== undefined) req.write(request.body);
    req.end();
  });
