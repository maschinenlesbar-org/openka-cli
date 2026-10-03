// The validation layer every library function guards its inputs with. What it
// throws is load-bearing: the CLI maps the class to exit 2 and prints the message
// as it is, so both have to stay exactly what the tests below pin.

import { deepStrictEqual, ok, rejects, strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BLANK_REASON,
  OpenKaError,
  OpenKaValidationError,
  UsageError,
  assertValid,
  isBlank,
  nonBlankProblem,
  type Problem,
} from "../src/index.js";

const positive: Problem<number> = (value) => (value > 0 ? undefined : "Must be >= 1.");

describe("assertValid", () => {
  it("passes a valid value without a word", () => {
    assertValid("limit", 3, positive);
  });

  it("throws OpenKaValidationError naming the input and the reason", () => {
    throws(
      () => assertValid("limit", 0, positive),
      (error: unknown) => {
        ok(error instanceof OpenKaValidationError);
        strictEqual(error.message, "Invalid limit: Must be >= 1.");
        strictEqual(error.reason, "Must be >= 1.");
        strictEqual(error.name, "OpenKaValidationError");
        return true;
      },
    );
  });

  it("is a UsageError, so every existing usage-error check still catches it", () => {
    const error = new OpenKaValidationError("Invalid x: y", { reason: "y" });
    ok(error instanceof UsageError);
    ok(error instanceof OpenKaError);
  });

  it("becomes a rejection inside an async function, not a synchronous throw", async () => {
    const guarded = async (limit: number): Promise<number> => {
      assertValid("limit", limit, positive);
      return limit;
    };
    const pending = guarded(0);
    ok(pending instanceof Promise);
    await rejects(pending, OpenKaValidationError);
  });
});

describe("the blank rule", () => {
  it("calls empty and whitespace-only strings blank, and nothing else", () => {
    deepStrictEqual(["", " ", "\t\n"].map(isBlank), [true, true, true]);
    deepStrictEqual(["deu", " x "].map(isBlank), [false, false]);
  });

  it("lets an omitted value through but not a blank one", () => {
    strictEqual(nonBlankProblem(undefined), undefined);
    strictEqual(nonBlankProblem("deu"), undefined);
    strictEqual(nonBlankProblem(""), BLANK_REASON);
    strictEqual(nonBlankProblem("  "), BLANK_REASON);
    strictEqual(BLANK_REASON, "Expected a non-empty value.");
  });
});
