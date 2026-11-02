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

import { withDiscoveryState, type DiscoverOptions, type DiscoverResult, type DocRef, type DocRefDocument, type Source, type CountOptions, type UpstreamCount } from "@maschinenlesbar.org/openka-lib-source";
import { parseReference } from "@maschinenlesbar.org/openka-lib-models";
import { ParlamentsspiegelSource } from "@maschinenlesbar.org/openka-lib-parlamentsspiegel";
import type { SourceEntry } from "@maschinenlesbar.org/openka-lib-source";

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
    "Discovery runs through the Parlamentsspiegel, which lists the answer as a follow-up document. " +
    "The answer is a separate Drucksache that reprints the question, and a build-time sweep " +
    "(`ka-factory answers niedersachsen`) reads the papers to confirm which question each one " +
    "answers; where that frozen map has an entry it is authoritative, because it was read rather " +
    "than inferred from a result row.";

  private readonly aggregator = new ParlamentsspiegelSource("niedersachsen");

  /** The aggregator's count: discovery runs through it, so that is what a sync would see. */
  async count(options: CountOptions): Promise<UpstreamCount> {
    return this.aggregator.count(options);
  }

  async discover(options: DiscoverOptions): Promise<DiscoverResult> {
    const discovered = await this.aggregator.discover(options);
    const warnings = [...discovered.warnings];
    const stored = options.store?.loadArtifact<unknown>(ANSWER_INDEX);
    if (stored !== undefined && !isAnswerMap(stored)) {
      warnings.push(
        `the corpus's ${ANSWER_INDEX} artifact is not an answer index, so it is ignored and the answers come from ` +
          "the Parlamentsspiegel rows; rebuild it with `ka-factory answers niedersachsen`.",
      );
    }
    const index = stored !== undefined && isAnswerMap(stored) ? stored : undefined;

    if (index === undefined) {
      warnings.push(
        "no answer index in this corpus — the answer is taken from the Parlamentsspiegel row, " +
          "which lists one only for a Vorgang the portal has already linked. " +
          "Build one with `ka-factory answers niedersachsen --period 19 --from … --to …`.",
      );
      return withDiscoveryState(discovered, discovered.refs, warnings);
    }

    let refused = 0;
    const refs: DocRef[] = discovered.refs.map((ref) => {
      const answer = Object.hasOwn(index.answers, ref.reference) ? index.answers[ref.reference] : undefined;
      if (answer === undefined) return ref;
      if (!isLandtagAnswer(answer)) {
        refused++;
        return ref;
      }
      // The answer paper reprints the question above the reply, so it is combined.
      // It replaces whatever follow-up the result row named rather than joining it:
      // they are the same paper, and appending would fetch and extract it twice.
      const documents: DocRefDocument[] = [
        ...ref.documents.filter((document) => document.role === "question_pdf"),
        { role: "combined_pdf", url: answer.url, urlStable: true },
      ];
      return { ...ref, documents };
    });
    if (refused > 0) {
      warnings.push(
        `${refused} ${refused === 1 ? "entry" : "entries"} of the corpus's answer index ${refused === 1 ? "is" : "are"} not an https URL on ` +
          `${LANDTAG_HOST}, which is all \`ka-factory answers niedersachsen\` writes; ignored, and the Parlamentsspiegel row used instead.`,
      );
    }
    return withDiscoveryState(discovered, refs, warnings);
  }
}

/** The Landtag's own host: the only one an answer-index URL may name. */
const LANDTAG_HOST = new URL(LANDTAG_NDS).host;

/**
 * Whether a stored artifact has the shape the factory writes, as far as discovery reads
 * it: an object whose `answers` is an object. The index is read back from the corpus,
 * which may have come from someone else, so it is not trusted as typed.
 */
function isAnswerMap(value: unknown): value is Pick<AnswerIndex, "answers"> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const answers = (value as { answers?: unknown }).answers;
  return typeof answers === "object" && answers !== null && !Array.isArray(answers);
}

/**
 * Whether an answer-index entry is one the factory could have written: a reference and
 * an https URL on the Landtag's host. Every URL it writes is `niedersachsenUrl(…)`; a
 * hand-edited entry naming another host made `ka sync` request robots.txt and the path
 * there — loopback and the private network included — and archive what looked like a
 * PDF (security audit 2026-10-27).
 */
function isLandtagAnswer(entry: unknown): entry is AnswerEntry {
  if (typeof entry !== "object" || entry === null) return false;
  const { reference, url } = entry as { reference?: unknown; url?: unknown };
  if (typeof reference !== "string" || typeof url !== "string") return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "https:" && parsed.host === LANDTAG_HOST && parsed.username === "" && parsed.password === "";
}

/** How this connector announces itself to the registry and `ka sources list`. */
export const ENTRY: SourceEntry = {
  key: "niedersachsen",
  parliament: "niedersachsen",
  label: "Niedersächsischer Landtag",
  status: "implemented",
  note: "aggregator discovery; answers come from a frozen map built by `ka-factory answers niedersachsen`",
  factory: () => new NiedersachsenSource(),
};
