// A fingerprint of the frozen extraction rules.
//
// `extraction.extractor_version` is the anchor of the reproducibility claim: the
// promise is that the same `extractor_version` and the same `input_sha256` yield
// the same bytes. That promise is only worth something if the stamp actually
// changes when the rules change — and the package version does not, because
// segmentation rules move far more often than a release does. Bumping it by hand
// is not a mechanism either: CLAUDE.md already says a rule change is "an extractor
// version bump and a golden re-freeze, not a tweak", and every rule family added
// so far shipped under the same `pkg:0.0.1`.
//
// So the stamp derives from the rules themselves. Editing a pattern, a guard
// threshold or a layout constant changes this fingerprint automatically, which
// makes `ka verify` tell the truth: "a different extractor produced this" rather
// than "the same extractor produced different bytes".
//
// Only what can change the *output* is included. Descriptions are left out so
// improving a comment does not invalidate a corpus.

import { createHash } from "node:crypto";
import { LINE_TOLERANCE_EM, WORD_GAP_EM } from "../pdf/text.js";
import {
  LARGE_QUESTION_LIST,
  MAX_NUMBER_SKIP,
  MIN_ANSWER_RATE_LARGE,
  MIN_INFERRED_ANSWER_RATE,
  MIN_NUMBER_DENSITY,
  RULE_SETS,
  type SegmentationRules,
} from "./segment.js";

/** The behaviour-bearing part of one rule family, in a stable shape. */
function describeRules(rules: SegmentationRules): unknown[] {
  const pattern = (value: RegExp | undefined): string | null => (value === undefined ? null : `${value.source}/${value.flags}`);
  return [
    rules.key,
    pattern(rules.question),
    pattern(rules.answer),
    pattern(rules.subQuestion),
    pattern(rules.subAnswer),
    pattern(rules.unnumberedAnswer),
    rules.bareNumbering === true,
    rules.answerFollowsQuestion === true,
    rules.onlyWhenUnmarked === true,
  ];
}

/**
 * Everything that decides what a document turns into: the rule families in the
 * order they are tried, the consistency guards, and the two page-layout constants
 * that decide where words and lines begin.
 */
export function extractionRuleDescription(): string {
  return JSON.stringify([
    RULE_SETS.map(describeRules),
    ["MIN_NUMBER_DENSITY", MIN_NUMBER_DENSITY],
    ["MIN_INFERRED_ANSWER_RATE", MIN_INFERRED_ANSWER_RATE],
    ["LARGE_QUESTION_LIST", LARGE_QUESTION_LIST],
    ["MIN_ANSWER_RATE_LARGE", MIN_ANSWER_RATE_LARGE],
    ["MAX_NUMBER_SKIP", MAX_NUMBER_SKIP],
    ["WORD_GAP_EM", WORD_GAP_EM],
    ["LINE_TOLERANCE_EM", LINE_TOLERANCE_EM],
  ]);
}

let cached: string | undefined;

/**
 * Twelve hex characters of the rule description's sha256 — long enough that two
 * rule sets will not collide, short enough to read in a record.
 */
export function extractionRulesFingerprint(): string {
  if (cached === undefined) {
    cached = createHash("sha256").update(extractionRuleDescription(), "utf8").digest("hex").slice(0, 12);
  }
  return cached;
}
