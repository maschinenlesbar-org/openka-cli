// The error types. There is no behaviour here beyond construction and one
// predicate, but both are load-bearing: `isRetryable` decides whether the engine
// backs off and tries again, and `AbstainError` is how "we do not know" stays
// distinguishable from "there is nothing there".

import { match, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AbstainError,
  NetworkError,
  OpenKaApiError,
  OpenKaError,
  ParseError,
  StoreError,
  UsageError,
} from "../src/index.js";

describe("the error hierarchy", () => {
  it("makes every type catchable as OpenKaError", () => {
    for (const error of [
      new NetworkError("down"),
      new ParseError("not a PDF"),
      new StoreError("no corpus"),
      new UsageError("bad flag"),
      new AbstainError("dates.answered", "no date in the document"),
      new OpenKaApiError({ status: 500, url: "https://x.invalid/a", method: "GET", body: "" }),
    ]) {
      ok(error instanceof OpenKaError, `${error.constructor.name} is not an OpenKaError`);
      ok(error instanceof Error);
      strictEqual(error.name, error.constructor.name);
      ok(error.stack !== undefined);
    }
  });
});

describe("an API error", () => {
  const error = (status: number): OpenKaApiError =>
    new OpenKaApiError({ status, url: "https://x.invalid/a", method: "GET", body: "oops" });

  it("says what failed in its message and keeps the parts", () => {
    const err = error(404);
    match(err.message, /HTTP 404 for GET https:\/\/x\.invalid\/a/);
    strictEqual(err.status, 404);
    strictEqual(err.url, "https://x.invalid/a");
    strictEqual(err.method, "GET");
    strictEqual(err.body, "oops");
  });

  it("calls only the documented transient statuses retryable", () => {
    // The engine backs off on these and gives up on the rest, so the list is a
    // behaviour and not a detail.
    strictEqual(error(429).isRetryable, true);
    strictEqual(error(503).isRetryable, true);
    for (const status of [400, 401, 403, 404, 418, 500, 502, 504]) {
      strictEqual(error(status).isRetryable, false, `${status} should not be retried`);
    }
  });
});

describe("an abstention", () => {
  it("carries the field and the reason, not just a sentence", () => {
    // The field is a path into the record, and the pipeline copies it into
    // `abstained_fields` — so it has to survive as data, not only as prose.
    const err = new AbstainError("qa[3].answer", "the rule set ran past the next heading");
    strictEqual(err.field, "qa[3].answer");
    strictEqual(err.reason, "the rule set ran past the next heading");
    match(err.message, /Abstained on qa\[3\]\.answer: the rule set ran past/);
  });
});
