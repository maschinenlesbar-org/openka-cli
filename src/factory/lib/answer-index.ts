// The Niedersachsen answer sweep — a build-time job that recovers a link no
// interface exposes.
//
// Niedersachsen publishes an answered Kleine Anfrage as a *new* Drucksache, a
// combined paper headed "mit Antwort der Landesregierung" that names the original
// in its header (`Drs. 19/7745`). Nothing queryable connects the two: the
// Parlamentsspiegel will not render the answer, the Landtag's document search is a
// browse filter behind server-computed cache hashes, and NILAS is unreachable from
// outside. What *is* available is every Drucksache at a predictable URL.
//
// So the link is recovered the only way left: read the answers. That is far too
// expensive for a sync — hundreds of PDFs for one window — which is exactly why it
// belongs on the factory plane. It runs once over a number range, freezes a
// question→answer map as an artifact, and the line consumes it (CONCEPT.md §0).

import type { FetchEngine } from "../../core/http/engine.js";
import { OpenKaApiError, OpenKaError } from "../../core/errors.js";
import { extractPdfText } from "../../core/pdf/index.js";
import type { Store } from "../../core/store/store.js";
import {
  ANSWER_INDEX,
  citedQuestion,
  isAnsweredEdition,
  mergeRanges,
  niedersachsenUrl,
  type AnswerEntry,
  type AnswerIndex,
} from "../../sources/niedersachsen.js";

export interface SweepOptions {
  engine: FetchEngine;
  store: Store;
  period: number;
  from: number;
  to: number;
  /** Keep entries from a previous sweep instead of replacing the map. */
  merge?: boolean;
  /** ISO instant to stamp the artifact with; injected so a run is reproducible. */
  now: string;
  onProgress?: (event: { number: number; outcome: "answer" | "question" | "missing" | "unreadable" }) => void;
}

export interface SweepReport {
  scanned: number;
  answers: number;
  questions: number;
  missing: number;
  unreadable: number;
  /** Entries in the artifact after the sweep, including any carried over. */
  total: number;
}

/**
 * Walk a Drucksachen range, reading only what is needed from each paper: whether it
 * is an answer edition, and which question it names. A paper that is missing, that
 * will not parse, or that names no question contributes nothing — the map records
 * links that were read, never links that were inferred from adjacency.
 */
export async function sweepAnswers(options: SweepOptions): Promise<SweepReport> {
  const existing = options.merge === true ? options.store.loadArtifact<AnswerIndex>(ANSWER_INDEX) : undefined;
  if (existing !== undefined && existing.period !== options.period) {
    // The ranges are Drucksachennummern *within* a period, so merging across one
    // would silently relabel the artifact and produce a coverage claim that spans
    // two numbering schemes. Refuse rather than write a map nobody can interpret.
    throw new OpenKaError(
      `The stored answer map is for period ${existing.period}, not ${options.period}. ` +
        "Sweep without --merge to replace it, or sweep the period it already covers.",
    );
  }
  const answers: Record<string, AnswerEntry> = { ...(existing?.answers ?? {}) };
  const report: SweepReport = { scanned: 0, answers: 0, questions: 0, missing: 0, unreadable: 0, total: 0 };

  for (let number = options.from; number <= options.to; number++) {
    report.scanned++;
    const url = niedersachsenUrl(options.period, number);
    let bytes: Buffer;
    try {
      const response = await options.engine.get(url);
      bytes = response.body;
    } catch (err) {
      // A gap in the numbering is ordinary: not every number is published.
      if (err instanceof OpenKaApiError && err.status === 404) {
        report.missing++;
        options.onProgress?.({ number, outcome: "missing" });
        continue;
      }
      throw err;
    }

    let text: string;
    try {
      text = extractPdfText(bytes).text;
    } catch {
      report.unreadable++;
      options.onProgress?.({ number, outcome: "unreadable" });
      continue;
    }

    if (!isAnsweredEdition(text)) {
      report.questions++;
      options.onProgress?.({ number, outcome: "question" });
      continue;
    }
    const question = citedQuestion(text);
    if (question === undefined) {
      // An answer that names no question is not evidence of a link.
      report.unreadable++;
      options.onProgress?.({ number, outcome: "unreadable" });
      continue;
    }
    answers[question] = { reference: `${options.period}/${number}`, url };
    report.answers++;
    options.onProgress?.({ number, outcome: "answer" });
  }

  const index: AnswerIndex = {
    built_at: options.now,
    period: options.period,
    ranges: mergeRanges(existing?.ranges ?? [], { from: options.from, to: options.to }),
    answers,
  };
  options.store.saveArtifact(ANSWER_INDEX, index);
  report.total = Object.keys(answers).length;
  return report;
}
