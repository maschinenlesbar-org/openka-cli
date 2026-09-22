// Post-extraction validators: the last gate before a record is published.
//
// A validator answers one question — "is this value possible?" — and when the
// answer is no, the field is dropped and abstained on. It never repairs a value:
// a corrected date is a fact nobody checked, which is precisely what this project
// exists not to produce.

import { isCalendarDate } from "@maschinenlesbar.org/openka-lib-models";
import type { KaRecord } from "@maschinenlesbar.org/openka-lib-models";

export interface ValidatorProblem {
  /** The field to abstain on, in the same path form as `abstained_fields`. */
  path: string;
  message: string;
}

/**
 * Whether the record has an answer at all.
 *
 * Three signals, because no one of them holds for every Land: the Bundestag's
 * answer is its own Drucksache, Schleswig-Holstein prints it inside the question's
 * document, and a reply written as continuous prose yields no Q/A pair with an
 * answer even though it plainly is one.
 */
function isAnswered(record: KaRecord): boolean {
  return (
    record.dates.answered !== undefined ||
    record.qa.some((pair) => pair.answer !== undefined) ||
    record.source_documents.some((document) => document.role === "answer_pdf" || document.role === "combined_pdf")
  );
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

  // A title the source did not carry arrives here as "" — every adapter writes
  // `?? ""` for it — and an empty title is otherwise indistinguishable from a
  // document that genuinely has none. Every other missing field in this project is
  // visible in `abstained_fields`; this was the one that was not.
  if (record.title.trim() === "") {
    problems.push({ path: "title", message: "the source carried no title" });
  }

  // An answered document had an answering body. Not knowing which one is a hole
  // like any other, and it was the last one this project kept invisible: the field
  // was simply absent, `abstained_fields` stayed empty and `review_status` stayed
  // `ok`. An *unanswered* document has no answering ministry to know, so it is not
  // abstained on — "we do not know" and "there is none" are different facts, and
  // this is the only place that can tell them apart.
  if (record.answered_by.ministry === undefined && isAnswered(record)) {
    problems.push({ path: "answered_by.ministry", message: "the document is answered but names no answering body" });
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
