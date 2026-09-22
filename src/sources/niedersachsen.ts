// Niedersachsen: the Niedersächsischer Landtag, where the answer is a *different*
// Drucksache from the question and nothing reachable links the two.
//
// The Landtag republishes an answered Anfrage under a new number as a combined
// paper — "Kleine Anfrage zur schriftlichen Beantwortung … mit Antwort der
// Landesregierung" — and that paper names the original: `Drs. 19/7745`. The link is
// therefore recoverable, but only by reading the answer, which means reading every
// candidate Drucksache. That is a build-time sweep, not something a sync should do,
// so the factory (`ka-factory answers niedersachsen`) builds a question→answer map
// and freezes it; this adapter consumes it.
//
// Why not ask a search interface instead: the Parlamentsspiegel knows an answer
// exists and never renders it, the Landtag's own document search is a browse filter
// with server-computed cache hashes, and NILAS's STARWEB entry point is not
// reachable from outside. DEVELOPING.md records what was tried.

import { withDiscoveryState, type DiscoverOptions, type DiscoverResult, type DocRef, type DocRefDocument, type Source } from "./base.js";
import { parseReference } from "../core/models/reference.js";
import { ParlamentsspiegelSource } from "./parlamentsspiegel.js";

export const LANDTAG_NDS = "https://www.landtag-niedersachsen.de";

/** The artifact name the factory writes and this adapter reads. */
export const ANSWER_INDEX = "niedersachsen-answers";

/** One entry of the frozen map: the answer paper for a question's Drucksachennummer. */
export interface AnswerEntry {
  /** The answer's own Drucksachennummer, e.g. `19/8100`. */
  reference: string;
  url: string;
}

/** One inclusive Drucksachen range that a sweep actually read. */
export interface SweptRange {
  from: number;
  to: number;
}

export interface AnswerIndex {
  /** ISO instant the sweep ran; `ka sources show` can say how stale the map is. */
  built_at: string;
  period: number;
  /**
   * The ranges actually read, so a later run knows what is already covered.
   *
   * A list rather than one from/to pair: merging two disjoint sweeps (7900–8000
   * and 9000–9100) into a single span would claim the 999 numbers between them
   * had been read. A later run would then skip them and the map would look
   * complete while being silently full of holes — the failure this project is
   * built to avoid.
   */
  ranges: SweptRange[];
  /** Question Drucksachennummer -> the answer that names it. */
  answers: Record<string, AnswerEntry>;
}

/**
 * Add a range to a covered set, sorted, with overlapping and adjacent ranges
 * coalesced. Adjacent means `to + 1 === from`: number 8000 and number 8001 leave
 * no gap between them.
 */
export function mergeRanges(existing: readonly SweptRange[], added: SweptRange): SweptRange[] {
  const sorted = [...existing, added].sort((a, b) => a.from - b.from || a.to - b.to);
  const merged: SweptRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && range.from <= last.to + 1) last.to = Math.max(last.to, range.to);
    else merged.push({ from: range.from, to: range.to });
  }
  return merged;
}

/** True when every number from `from` to `to` lies inside a swept range. */
export function isCovered(index: AnswerIndex, from: number, to: number): boolean {
  return index.ranges.some((range) => range.from <= from && range.to >= to);
}

/**
 * The archive path of a Drucksache. Verified across six numbers spanning several
 * ranges and both folder boundaries: the outer folder is the number rounded up to a
 * multiple of 2500, the inner one its 500-wide block.
 *
 *   19/7605 -> /Drucksachen/Drucksachen_19_10000/07501-08000/19-07605.pdf
 */
export function niedersachsenUrl(period: number, number: number): string {
  const outer = Math.ceil(number / 2500) * 2500;
  const low = Math.floor((number - 1) / 500) * 500 + 1;
  const pad = (value: number): string => String(value).padStart(5, "0");
  return `${LANDTAG_NDS}/Drucksachen/Drucksachen_${period}_${pad(outer)}/${pad(low)}-${pad(low + 499)}/${period}-${pad(number)}.pdf`;
}

/** The numeric part of a Drucksachennummer, or `undefined` if it is not one. */
export function numberOf(reference: string): number | undefined {
  const parsed = parseReference(reference);
  return parsed === undefined ? undefined : Number(parsed.number);
}

/**
 * True when a document is the combined edition carrying the government's reply.
 * The phrase is the Landtag's own, printed under the heading of every answered
 * Anfrage and absent from every unanswered one.
 */
export function isAnsweredEdition(text: string): boolean {
  return /mit\s+Antwort\s+der\s+Landesregierung/i.test(text);
}

/**
 * The question a combined paper answers, cited in its header as `Drs. 19/7745`.
 * Returns `undefined` when no citation is present — a paper that names no question
 * is not evidence of a link, and inventing one would put an answer under the wrong
 * Anfrage.
 */
export function citedQuestion(text: string): string | undefined {
  const match = /\bDrs\.?\s*(\d{1,2})\s*\/\s*(\d{1,6})\b/.exec(text);
  return match === null ? undefined : `${match[1]}/${match[2]}`;
}

export class NiedersachsenSource implements Source {
  readonly key = "niedersachsen";
  readonly parliament = "niedersachsen" as const;
  readonly tier = "structured" as const;
  readonly label = "Niedersächsischer Landtag";
  readonly homepage = "https://www.landtag-niedersachsen.de/dokumentensuche/";
  readonly notes =
    "Discovery runs through the Parlamentsspiegel, which knows an answer exists but never renders " +
    "it. The answer is a separate Drucksache that names the question in its header, so the link is " +
    "recovered by a build-time sweep (`ka-factory answers niedersachsen`) and frozen as an " +
    "artifact. Without that artifact this source yields question-only records, which is honest " +
    "rather than wrong.";

  private readonly aggregator = new ParlamentsspiegelSource("niedersachsen");

  async discover(options: DiscoverOptions): Promise<DiscoverResult> {
    const discovered = await this.aggregator.discover(options);
    const warnings = [...discovered.warnings];
    const index = options.store?.loadArtifact<AnswerIndex>(ANSWER_INDEX);

    if (index === undefined) {
      warnings.push(
        "no answer index in this corpus — records will carry the question only. " +
          "Build one with `ka-factory answers niedersachsen --period 19 --from … --to …`.",
      );
      return withDiscoveryState(discovered, discovered.refs, warnings);
    }

    const refs: DocRef[] = discovered.refs.map((ref) => {
      const answer = index.answers[ref.reference];
      if (answer === undefined) return ref;
      // The answer paper reprints the question above the reply, so it is combined.
      const documents: DocRefDocument[] = [
        ...ref.documents,
        { role: "combined_pdf", url: answer.url, urlStable: true },
      ];
      return { ...ref, documents };
    });
    return withDiscoveryState(discovered, refs, warnings);
  }
}
