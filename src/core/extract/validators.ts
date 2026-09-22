// Post-extraction validators: the last gate before a record is published.
//
// A validator answers one question — "is this value possible?" — and when the
// answer is no, the field is dropped and abstained on. It never repairs a value:
// a corrected date is a fact nobody checked, which is precisely what this project
// exists not to produce.

import { isCalendarDate } from "../models/validate.js";
import type { KaRecord } from "../models/schema.js";

export interface ValidatorProblem {
  /** The field to abstain on, in the same path form as `abstained_fields`. */
  path: string;
  message: string;
}

/**
 * The earliest plausible date for a document in this corpus. The Bundestag's
 * records start in 1949 and the Länder's documentation systems do not reach
 * further back, so an earlier date is an extraction error, not history.
 */
export const EARLIEST_PLAUSIBLE_YEAR = 1949;

/** Years beyond this are typos or misreads; a Drucksache is not dated in advance. */
export function latestPlausibleYear(now: Date = new Date()): number {
  return now.getUTCFullYear() + 1;
}

/**
 * Run every validator.
 *
 * `now` is the instant "not dated in advance" is judged against. It is a parameter
 * rather than a call to the clock because the decision has to be reproducible: a
 * record re-extracted years later must abstain on exactly the fields it abstained
 * on the first time, or `ka verify` reports a mismatch that says nothing about the
 * data. Callers pass the instant the bytes were archived, which the record carries.
 *
 * When `now` is undefined the upper bound is simply not asserted. Without a known
 * instant there is nothing to call "the future", and inventing one from the wall
 * clock is what made this non-reproducible in the first place.
 */
export function validateExtractedRecord(record: KaRecord, now?: Date): ValidatorProblem[] {
  const problems: ValidatorProblem[] = [];
  const latest = now === undefined ? undefined : latestPlausibleYear(now);

  for (const key of ["submitted", "answered"] as const) {
    const value = record.dates[key];
    if (value === undefined) continue;
    if (!isCalendarDate(value)) {
      problems.push({ path: `dates.${key}`, message: `"${value}" is not a calendar date` });
      continue;
    }
    const year = Number(value.slice(0, 4));
    if (year < EARLIEST_PLAUSIBLE_YEAR || (latest !== undefined && year > latest)) {
      problems.push({
        path: `dates.${key}`,
        message: `year ${year} is outside the plausible range ${EARLIEST_PLAUSIBLE_YEAR}..${latest ?? "?"}`,
      });
    }
  }

  const { submitted, answered } = record.dates;
  if (
    submitted !== undefined &&
    answered !== undefined &&
    isCalendarDate(submitted) &&
    isCalendarDate(answered) &&
    answered < submitted
  ) {
    // Which of the two is wrong is unknowable from here, so the answer date — the
    // one derived later in the document — is the one dropped.
    problems.push({ path: "dates.answered", message: `answered ${answered} precedes submitted ${submitted}` });
  }

  record.qa.forEach((pair, index) => {
    if (pair.question !== undefined && pair.question.trim() === "") {
      problems.push({ path: `qa[${index}].question`, message: "question text is empty" });
    }
    if (pair.answer !== undefined && pair.answer.trim() === "") {
      problems.push({ path: `qa[${index}].answer`, message: "answer text is empty" });
    }
    // A "question" the length of a page is a segmentation failure that swallowed
    // the rest of the document, not a genuinely long question.
    if (pair.question !== undefined && pair.question.length > 20_000) {
      problems.push({
        path: `qa[${index}].question`,
        message: `question text is ${pair.question.length} characters — the rule set ran past the next heading`,
      });
    }
  });

  return problems;
}
