// The library's input validation layer. A rule about what a caller may pass is a
// pure function here, so the library enforces it before any request or write and
// the CLI's value parsers call the very same function — one rule, one message,
// whichever door the input came through.

import { OpenKaValidationError } from "./index.js";

/**
 * A validation rule: the reason `value` is invalid, phrased as a sentence the CLI
 * can print as it is ("Expected a non-empty value."), or `undefined` when it is
 * valid.
 */
export type Problem<T = unknown> = (value: T) => string | undefined;

/**
 * Throw `OpenKaValidationError("Invalid <name>: <reason>")` when `problem` finds
 * fault with `value`. A function that returns a promise calls this inside its
 * async body, so a rejected input becomes a rejection rather than a synchronous
 * throw; a constructor lets it throw.
 */
export function assertValid<T>(name: string, value: T, problem: Problem<T>): void {
  const reason = problem(value);
  if (reason !== undefined) throw new OpenKaValidationError(`Invalid ${name}: ${reason}`, { reason });
}

/** True for a string that is empty or only whitespace. */
export function isBlank(value: string): boolean {
  return value.trim() === "";
}

/** The reason a blank string is rejected: the CLI's `parseNonEmpty` says the same. */
export const BLANK_REASON = "Expected a non-empty value.";

/**
 * A present-but-blank string is a mistake, never a request for the default: the
 * default is what an omitted (`undefined`) value means.
 */
export const nonBlankProblem: Problem<string | undefined> = (value) =>
  value !== undefined && isBlank(value) ? BLANK_REASON : undefined;
