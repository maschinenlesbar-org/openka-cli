// Frozen segmentation rules: plain text of a Kleine Anfrage in, question/answer
// pairs out.
//
// These are the rules the factory writes and the line runs unchanged. They are
// written to *fail loudly*: a rule set either recognises a document's structure
// completely enough to pass its own consistency checks, or it reports that it did
// not, and the caller abstains on `qa`. Nothing here ever infers a question that is
// not marked in the document.
//
// Two heading families cover the documents this project has seen. Both occur in
// Berlin's own corpus, which is why the rule sets are tried in a fixed order rather
// than pinned per source:
//
//   Frage 1:                      1. Wie viele …?
//   Wie viele …?                  a. Und wie viele …?
//   Antwort zu 1:                 Zu 1: Nach Auskunft …
//   Nach Auskunft …               Zu 1 a): Der Senat …

/** A rule set knows how to spot question and answer headings in one document family. */
export interface SegmentationRules {
  key: string;
  description: string;
  /** Matches a question heading at the start of a line; group 1 is the number list. */
  question: RegExp;
  /**
   * Matches an answer heading at the start of a line; group 1 is the number list.
   * Absent for a family whose answers carry no heading — expressing that as "no
   * pattern" rather than as a pattern that matches nothing, because a regex written
   * to never match (`/$^/`) does in fact match an empty line.
   */
  answer?: RegExp;
  /**
   * Matches a letter-only sub-item (`a.`, `b)`) that belongs to the numbered
   * question above it; group 1 is the letter. Absent when the family has none.
   */
  subQuestion?: RegExp;
  /**
   * This family has no answer heading at all: the answer simply follows the
   * question. The split is made at the last line of the block that ends in a
   * question mark — see `splitAtQuestionMark`.
   */
  answerFollowsQuestion?: boolean;
  /**
   * Only believe this family when the text contains no answer headings anywhere.
   * A family that infers where the answer starts must not be allowed to compete
   * with one that can simply read it.
   */
  onlyWhenUnmarked?: boolean;
}

/**
 * One number in a heading: `1`, `2a`, `2 a`, `3.1`. The letter is only taken when
 * no further letter follows it, so `1 und 2` does not read the `u` of `und` as a
 * sub-item letter.
 */
const NUMBER = String.raw`[0-9]+(?:\.[0-9]+)*\.?(?:[ \t]*[a-z](?![a-z])\.?)?`;

/**
 * A bare list item's number, capped at three digits. Uncapped, a figure in a table
 * ("1163535.") reads as question 1 163 535, and the consistency check then rejects
 * a document that was otherwise fine — the cap keeps the failure from happening at
 * all rather than diagnosing it afterwards.
 */
const SHORT_NUMBER = String.raw`[0-9]{1,3}(?:\.[0-9]+)*\.?(?:[ \t]*[a-z](?![a-z])\.?)?`;
const SEPARATOR = String.raw`(?:,|und|bis|sowie|-|–|—)`;

/**
 * German month names, used as a negative lookahead on bare numbered list items.
 * A paragraph beginning "12. November 2021 mehr als 50.000 Straftaten …" is a
 * sentence, not question 12, and letting it through invents a question number that
 * then makes the whole document look misparsed.
 */
const MONTH = String.raw`(?:Januar|Februar|M(?:ä|ae)rz|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember)`;
const NUMBER_LIST = `(${NUMBER}(?:[ \\t]*${SEPARATOR}[ \\t]*${NUMBER})*)`;
const SHORT_NUMBER_LIST = `(${SHORT_NUMBER}(?:[ \\t]*${SEPARATOR}[ \\t]*${SHORT_NUMBER})*)`;

/**
 * The heading style with an explicit `Frage N:` above each question. Its answer
 * heading must contain the word "Antwort": the bare `Zu N:` form belongs to the
 * numbered family, and letting both families claim it made this rule set win on
 * documents whose questions it cannot see at all.
 */
export const FRAGE_ANTWORT: SegmentationRules = {
  key: "frage_antwort",
  description: "Frage N: / Antwort zu N: headings",
  question: new RegExp(`^[ \\t]*Frage[n]?[ \\t]+${NUMBER_LIST}[ \\t]*[.:)]*[ \\t]*`, "i"),
  answer: new RegExp(
    `^[ \\t]*Antwort(?:en)?[ \\t]*(?:zu[ \\t]+)?(?:Frage[n]?[ \\t]+)?${NUMBER_LIST}[ \\t]*[.:)]*[ \\t]*`,
    "i",
  ),
};

/** The style where the question is a numbered list item and the answer says `Zu N`. */
export const NUMMERIERT: SegmentationRules = {
  key: "nummeriert",
  description: "`N.` numbered questions with `Zu N.` answers, including `a.` sub-items",
  question: new RegExp(`^[ \\t]*${SHORT_NUMBER_LIST}[.)][ \\t]+(?!${MONTH}\\b)(?=\\S)`),
  answer: new RegExp(
    `^[ \\t]*(?:Antwort(?:en)?[ \\t]+(?:zu[ \\t]+)?(?:Frage[n]?[ \\t]+)?|Zu[ \\t]+(?:Frage[n]?[ \\t]+)?)${NUMBER_LIST}[ \\t]*[.:)]*[ \\t]*`,
    "i",
  ),
  subQuestion: /^[ \t]*([a-z])[.)][ \t]+(?=\S)/,
};

/**
 * The Bundestag's answer Drucksachen: the question is reprinted as a numbered item
 * and the government's answer follows it directly, with no heading of any kind.
 *
 * Inferring where a question ends is a weaker move than reading a heading, so this
 * family is only consulted when the document has no answer headings at all.
 */
export const ANTWORT_FOLGT: SegmentationRules = {
  key: "antwort_folgt",
  description: "numbered questions whose answer follows directly (Bundestag answer Drucksachen)",
  question: new RegExp(`^[ \\t]*${SHORT_NUMBER_LIST}[.)][ \\t]+(?!${MONTH}\\b)(?=\\S)`),
  subQuestion: /^[ \t]*([a-z])[.)][ \t]+(?=\S)/,
  answerFollowsQuestion: true,
  onlyWhenUnmarked: true,
};

/** Rule sets are tried in this fixed order, so the choice is reproducible. */
export const RULE_SETS: readonly SegmentationRules[] = [FRAGE_ANTWORT, NUMMERIERT, ANTWORT_FOLGT];

/**
 * A government answering several questions at once, in the sentence every German
 * parliament uses for it: "Die Fragen 1 und 2 werden aufgrund des Sachzusammenhangs
 * gemeinsam beantwortet." The answer then sits under the last of the grouped
 * questions and the earlier ones look unanswered — which is a hole we would
 * otherwise report, in a document that answered everything it was asked.
 */
const GROUPED_ANSWER = new RegExp(
  `\\bDie\\s+Frage[n]?\\s+${NUMBER_LIST}\\s+werden\\b[^.]{0,160}?\\bbeantwortet\\b`,
  "i",
);

/** The question numbers an answer body says it also covers. */
export function groupedAnswerNumbers(body: string): string[] {
  // Only the opening of the answer is considered: a sentence deep inside a long
  // answer is discussing something else, not announcing this answer's scope.
  const match = GROUPED_ANSWER.exec(body.slice(0, 400));
  return match === null ? [] : expandNumbers(match[1] as string);
}

/** Any answer heading at all — the guard for `onlyWhenUnmarked`. */
const ANY_ANSWER_HEADING = new RegExp(
  `^[ \\t]*(?:Antwort(?:en)?[ \\t]*(?:zu[ \\t]+)?(?:Frage[n]?[ \\t]+)?|Zu[ \\t]+(?:Frage[n]?[ \\t]+)?)${NUMBER_LIST}`,
  "im",
);

/**
 * Split a block into the question and the answer that follows it.
 *
 * Two steps, because documents mark the boundary in two different ways:
 *
 *  1. **By paragraph.** The question is the leading paragraphs up to and including
 *     the last one containing a question mark; the rest is the answer. This is what
 *     NRW needs: its questions read "… zu gewinnen? (Bitte nach Maßnahmenart
 *     differenzieren)", so the question mark is not at the end of the question, and
 *     a line-based rule loses the whole answer.
 *  2. **By line**, when the block is a single paragraph: the question ends at the
 *     last line ending in a question mark. This is what the Bundestag needs, where
 *     the answer does not always start a new paragraph.
 *
 * The *last* question mark rather than the first, because a numbered item often
 * asks several things. A block with no question mark at all is all question and the
 * answer abstains — the honest reading of a question nobody answered.
 */
export function splitAtQuestionMark(body: string): { question: string; answer?: string } {
  const paragraphs = body.split(/\n[ \t]*\n/);
  if (paragraphs.length > 1) {
    let lastParagraph = -1;
    for (let i = 0; i < paragraphs.length; i++) {
      if ((paragraphs[i] as string).includes("?")) lastParagraph = i;
    }
    if (lastParagraph >= 0 && lastParagraph < paragraphs.length - 1) {
      return {
        question: paragraphs.slice(0, lastParagraph + 1).join("\n\n").trim(),
        answer: paragraphs.slice(lastParagraph + 1).join("\n\n").trim(),
      };
    }
  }

  const lines = body.split("\n");
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] as string).trimEnd().endsWith("?")) last = i;
  }
  if (last < 0) return { question: body.trim() };
  const question = lines.slice(0, last + 1).join("\n").trim();
  const answer = lines.slice(last + 1).join("\n").trim();
  return answer === "" ? { question } : { question, answer };
}

/**
 * How much of the range `1..max` a rule set has to account for before its reading
 * is believed. Two thirds tolerates an asker who skipped a number or two; it does
 * not tolerate eleven "questions" spread over the range 1..115.
 */
export const MIN_NUMBER_DENSITY = 0.66;

/**
 * How many of a family's questions must have ended up with an answer before an
 * *inferred* split is believed. The Bundestag sometimes reprints the whole question
 * list before answering anything; the split then finds almost no answers, and a
 * result where two of eighteen questions have text attached is not a reading of the
 * document — it is a handful of coincidences. Better to abstain on all of it.
 */
export const MIN_INFERRED_ANSWER_RATE = 0.6;

export interface QaSegment {
  number: string;
  question?: string;
  answer?: string;
}

export interface SegmentationResult {
  /** The rule set that was used, or `undefined` when none matched. */
  rules?: string;
  segments: QaSegment[];
  /** Why a rule set was rejected — one entry per rule set that was tried. */
  rejections: string[];
}

/**
 * `1 a` -> `1a`; `1. a)` -> `1a`; `2.1` stays `2.1`. Spaces go, case folds, and the
 * dots that are punctuation rather than sub-numbering are dropped — so the same
 * question referred to as "1. a)" in the answer and "a." in the question list gets
 * the same key.
 */
export function normaliseNumber(token: string): string {
  return token
    .replace(/[ \t]+/g, "")
    .toLowerCase()
    .replace(/\.(?=[a-z])/g, "")
    .replace(/[.)]+$/, "");
}

/**
 * Expand a heading's number list into the individual numbers it covers.
 * `2 und 3` -> ["2","3"];  `4 bis 6` -> ["4","5","6"];  `1 a` -> ["1a"].
 *
 * A range is only expanded when both ends are plain integers and the span is small;
 * a "range" of 40 numbers is far more likely to be a misread than a real grouping,
 * and expanding it would fabricate 40 question numbers.
 */
export function expandNumbers(list: string): string[] {
  const out: string[] = [];
  const parts = list.split(/[ \t]*(,|und|bis|sowie|-|–|—)[ \t]*/i);
  let pendingRange = false;
  for (const part of parts) {
    const token = normaliseNumber(part.trim());
    if (token === "") continue;
    if (/^(,|und|sowie)$/i.test(token)) {
      pendingRange = false;
      continue;
    }
    if (/^(bis|-|–|—)$/i.test(token)) {
      pendingRange = true;
      continue;
    }
    if (pendingRange) {
      pendingRange = false;
      const from = Number(out[out.length - 1]);
      const to = Number(token);
      if (Number.isInteger(from) && Number.isInteger(to) && to > from && to - from <= 30) {
        for (let n = from + 1; n <= to; n++) out.push(String(n));
        continue;
      }
    }
    if (!out.includes(token)) out.push(token);
  }
  return out;
}

interface Marker {
  kind: "question" | "answer";
  numbers: string[];
  /** Index of the line the heading sits on. */
  line: number;
  /** Text that followed the heading on the same line, if any. */
  inline: string;
}

function findMarkers(lines: string[], rules: SegmentationRules): Marker[] {
  const markers: Marker[] = [];
  /** The last plain integer seen, so `a.` can be resolved to `3a`. */
  let lastInteger: string | undefined;

  lines.forEach((line, index) => {
    const answer = rules.answer?.exec(line);
    if (answer?.[1] !== undefined) {
      markers.push({
        kind: "answer",
        numbers: expandNumbers(answer[1] as string),
        line: index,
        inline: line.slice(answer[0].length).trim(),
      });
      return;
    }
    const question = rules.question.exec(line);
    if (question?.[1] !== undefined) {
      const numbers = expandNumbers(question[1]);
      const plain = numbers.find((number) => /^[0-9]+$/.test(number));
      if (plain !== undefined) lastInteger = plain;
      markers.push({ kind: "question", numbers, line: index, inline: line.slice(question[0].length).trim() });
      return;
    }
    if (rules.subQuestion !== undefined && lastInteger !== undefined) {
      const sub = rules.subQuestion.exec(line);
      if (sub) {
        markers.push({
          kind: "question",
          numbers: [`${lastInteger}${(sub[1] as string).toLowerCase()}`],
          line: index,
          inline: line.slice(sub[0].length).trim(),
        });
      }
    }
  });
  return markers;
}

/**
 * Drop everything before the first heading numbered 1.
 *
 * Front matter numbers itself too — a Berlin cover page opens with
 * "19. Wahlperiode", and a numbered-list rule set matches that. Since question
 * numbering always restarts at 1, anything before the first `1` is not a question,
 * and cutting there is a rule rather than a guess. A text with no heading numbered
 * 1 at all is rejected downstream, not patched up.
 */
function dropFrontMatter(markers: Marker[]): Marker[] {
  const start = markers.findIndex((marker) => marker.numbers.some((number) => number === "1" || number === "1a"));
  return start <= 0 ? markers : markers.slice(start);
}

function bodyBetween(lines: string[], marker: Marker, next: Marker | undefined): string {
  const from = marker.line + 1;
  const to = next === undefined ? lines.length : next.line;
  const parts = marker.inline === "" ? [] : [marker.inline];
  for (let i = from; i < to; i++) parts.push(lines[i] as string);
  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Run one rule set. Returns the pairs it found plus why it is or is not usable. */
export function applyRules(text: string, rules: SegmentationRules): { segments: QaSegment[]; rejection?: string } {
  if (rules.onlyWhenUnmarked === true && ANY_ANSWER_HEADING.test(text)) {
    return { segments: [], rejection: `${rules.key}: the document has answer headings, so a family that reads them applies` };
  }
  const lines = text.split(/\r?\n/);
  const markers = dropFrontMatter(findMarkers(lines, rules));
  if (markers.length === 0) return { segments: [], rejection: `${rules.key}: no headings matched` };

  const order: string[] = [];
  const questions = new Map<string, string>();
  const answers = new Map<string, string>();

  markers.forEach((marker, i) => {
    const whole = bodyBetween(lines, marker, markers[i + 1]);
    const split = rules.answerFollowsQuestion === true && marker.kind === "question"
      ? splitAtQuestionMark(whole)
      : undefined;
    const body = split === undefined ? whole : split.question;
    for (const number of marker.numbers) {
      if (marker.kind === "question") {
        if (!order.includes(number)) order.push(number);
        if (split?.answer !== undefined && !answers.has(number)) answers.set(number, split.answer);
        // A number repeated as a question heading means the document restates it
        // (once in the question part, again above the answer); the first occurrence
        // is the question as asked.
        if (!questions.has(number)) questions.set(number, body);
      } else if (!answers.has(number)) {
        answers.set(number, body);
        if (!order.includes(number)) order.push(number);
      }
    }
  });

  // Propagate a grouped answer to every question it says it covers — but only to
  // numbers the document already showed us. A grouped sentence naming a question
  // that has no heading anywhere is a misread of the sentence, not a discovery of a
  // question, and adding it would invent a Q/A pair with no question in it.
  for (const body of [...answers.values()]) {
    for (const covered of groupedAnswerNumbers(body)) {
      if (order.includes(covered) && !answers.has(covered)) answers.set(covered, body);
    }
  }

  const segments: QaSegment[] = order.map((number) => {
    const segment: QaSegment = { number };
    const question = questions.get(number);
    const answer = answers.get(number);
    if (question !== undefined && question !== "") segment.question = question;
    if (answer !== undefined && answer !== "") segment.answer = answer;
    return segment;
  });

  const rejection = consistencyProblem(segments, rules.key, rules.answerFollowsQuestion === true);
  return rejection === undefined ? { segments } : { segments, rejection };
}

/**
 * The consistency checks a rule set's output must pass before it is believed.
 *
 * These exist because a regex will always match *something*: numbering that does
 * not start at 1, or that has holes, is the signature of a rule set latching onto
 * list items, table figures or footnotes rather than questions.
 *
 * The check is on the *set* of question numbers, not on the order they appear in.
 * Documents answer questions out of order — a real Berlin answer heads a section
 * "Zu 8. und 11., 11.a. bis d.:" and then carries on with 9 — and rejecting that
 * would throw away a correctly parsed document for being untidy.
 */
function consistencyProblem(segments: QaSegment[], key: string, inferredAnswers = false): string | undefined {
  if (segments.length === 0) return `${key}: matched no question/answer pairs`;
  const integers = segments.map((segment) => Number.parseInt(segment.number, 10));
  if (integers.some((value) => !Number.isInteger(value))) return `${key}: non-numeric question numbers`;

  const present = new Set(integers);
  if (!present.has(1)) return `${key}: no question numbered 1`;
  const highest = Math.max(...integers);
  const missing: number[] = [];
  for (let n = 1; n <= highest; n++) if (!present.has(n)) missing.push(n);

  // Holes are tolerated up to a point, because they happen for two opposite
  // reasons. A real answer sometimes reads "Zu 2. und 5. (siehe Ihre Nummerierung)"
  // because the asker's own numbering skipped — refusing that would throw away a
  // correctly read document. But a rule set that has latched onto table figures
  // produces a handful of numbers scattered over a huge range, and that must be
  // refused. Density separates the two cleanly.
  if (present.size < highest * MIN_NUMBER_DENSITY) {
    return (
      `${key}: only ${present.size} of the numbers 1..${highest} are present ` +
      `(holes at ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", …" : ""})`
    );
  }

  const withAnswer = segments.filter((segment) => segment.answer !== undefined).length;
  if (withAnswer === 0) return `${key}: no answers found for ${segments.length} question(s)`;
  if (inferredAnswers && withAnswer < segments.length * MIN_INFERRED_ANSWER_RATE) {
    return (
      `${key}: only ${withAnswer} of ${segments.length} questions are followed by an answer, ` +
      "which is too few to trust an inferred split"
    );
  }
  return undefined;
}

/**
 * Segment a document: run every rule set, keep the ones that pass their own
 * consistency checks, and take the one that recognised the most *questions*.
 *
 * Running all of them rather than stopping at the first success matters. A rule set
 * can pass its checks while seeing only half the structure — one family's answer
 * heading appears in documents whose questions it cannot match — and taking that
 * result would publish answers with no questions attached while a better reading
 * was available. Ties break on the declaration order, so the choice stays
 * reproducible.
 */
export function segmentQa(text: string, ruleSets: readonly SegmentationRules[] = RULE_SETS): SegmentationResult {
  const rejections: string[] = [];
  let best: { rules: SegmentationRules; segments: QaSegment[]; questions: number; answers: number } | undefined;

  ruleSets.forEach((rules) => {
    const { segments, rejection } = applyRules(text, rules);
    if (rejection !== undefined) {
      rejections.push(rejection);
      return;
    }
    const questions = segments.filter((segment) => segment.question !== undefined).length;
    const answers = segments.filter((segment) => segment.answer !== undefined).length;
    if (
      best === undefined ||
      questions > best.questions ||
      (questions === best.questions && answers > best.answers)
    ) {
      best = { rules, segments, questions, answers };
    }
  });

  if (best === undefined) return { segments: [], rejections };
  return { rules: best.rules.key, segments: best.segments, rejections };
}
