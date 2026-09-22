// Coverage and health metrics, and the drift signals derived from them.
//
// These are not pass/fail tests (CONCEPT.md §8): they are the quality signals that
// tell the factory *when* to do work. A parse-complete rate that falls, an
// abstention rate that spikes, a source whose discovery suddenly returns nothing —
// each is a symptom with a different cause, and the classification below is what
// turns a number into a job.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { canonicalJsonLine } from "../../core/repro/canonical.js";
import type { Store } from "../../core/store/store.js";
import { SOURCE_REGISTRY } from "../../sources/registry.js";

export interface SourceHealth {
  source: string;
  records: number;
  parse_complete: number;
  /** Share of records with at least one abstained field, 0..1. */
  abstention_rate: number;
  /** Share of records that produced at least one question/answer pair, 0..1. */
  qa_rate: number;
  by_tier: Record<string, number>;
  last_sync?: string;
  last_error?: string;
}

export interface HealthSnapshot {
  /** ISO instant; injected by the caller so a snapshot is reproducible in tests. */
  taken_at: string;
  records: number;
  sources: SourceHealth[];
}

/** Sources whose records are filed under other parliaments, so a zero here means nothing. */
function spanningSources(): Set<string> {
  return new Set(SOURCE_REGISTRY.filter((entry) => entry.parliament === undefined).map((entry) => entry.key));
}

/** Measure the corpus as it stands. */
export function measureHealth(store: Store, takenAt: string): HealthSnapshot {
  const perSource = new Map<string, { records: number; complete: number; qa: number; tiers: Map<string, number> }>();

  // Seed from the sources that have sync state, not only from the catalog. A
  // source is otherwise visible only through the records it produced, so a source
  // whose discovery returned nothing — the single symptom this report exists to
  // classify — left no row at all, and neither `no_results` nor `source_error`
  // could ever fire for it. The all-Länder aggregator is excluded: its records are
  // filed under sixteen other parliaments, so a zero of its own means nothing.
  const spanning = spanningSources();
  for (const key of store.sourceStateKeys()) {
    if (spanning.has(key)) continue;
    perSource.set(key, { records: 0, complete: 0, qa: 0, tiers: new Map() });
  }

  for (const entry of store.catalog()) {
    const bucket = perSource.get(entry.parliament) ?? { records: 0, complete: 0, qa: 0, tiers: new Map() };
    bucket.records++;
    if (entry.abstained === 0) bucket.complete++;
    bucket.tiers.set(entry.tier, (bucket.tiers.get(entry.tier) ?? 0) + 1);
    perSource.set(entry.parliament, bucket);
  }

  // The catalog does not carry the pair count, so the qa rate is read from the
  // records themselves. It is the single most useful number in this report: a
  // source can be fully "synced" and still tell you nothing.
  for (const id of store.recordIds()) {
    const record = store.getRecord(id);
    if (record === undefined || record.qa.length === 0) continue;
    const bucket = perSource.get(record.parliament);
    if (bucket !== undefined) bucket.qa++;
  }

  const sources: SourceHealth[] = [...perSource]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([source, bucket]) => {
      const state = store.getSourceState(source);
      const health: SourceHealth = {
        source,
        records: bucket.records,
        parse_complete: bucket.complete,
        abstention_rate: bucket.records === 0 ? 0 : round((bucket.records - bucket.complete) / bucket.records),
        qa_rate: bucket.records === 0 ? 0 : round(bucket.qa / bucket.records),
        by_tier: Object.fromEntries([...bucket.tiers].sort(([a], [b]) => (a < b ? -1 : 1))),
      };
      if (state.last_sync !== undefined) health.last_sync = state.last_sync;
      if (state.last_error !== undefined) health.last_error = state.last_error;
      return health;
    });

  return { taken_at: takenAt, records: sources.reduce((sum, source) => sum + source.records, 0), sources };
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export function loadBaseline(path: string): HealthSnapshot | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as HealthSnapshot;
}

export function saveBaseline(path: string, snapshot: HealthSnapshot): void {
  writeFileSync(path, canonicalJsonLine(snapshot));
}

export type DriftKind =
  | "no_results"
  | "source_error"
  | "abstention_spike"
  | "qa_collapse"
  | "coverage_drop"
  | "new_source";

export interface DriftFinding {
  source: string;
  kind: DriftKind;
  detail: string;
  /** What the factory should do about it — the classification step of §6. */
  suggestion: string;
}

/** How much the abstention rate may rise before it counts as a spike. */
export const ABSTENTION_SPIKE = 0.1;

/** How much the qa rate may fall before it counts as a collapse. */
export const QA_COLLAPSE = 0.1;

/**
 * Compare a snapshot against a baseline and classify what changed.
 *
 * The classification is the useful part. "Discovery returned nothing" points at
 * navigation or an endpoint that moved; "abstentions spiked while discovery is
 * fine" points at the document layout; they need different repairs, and saying
 * which is which is the difference between a heal loop and an alert.
 */
export function detectDrift(current: HealthSnapshot, baseline: HealthSnapshot | undefined): DriftFinding[] {
  const findings: DriftFinding[] = [];
  const previous = new Map((baseline?.sources ?? []).map((source) => [source.source, source]));

  for (const source of current.sources) {
    if (source.last_error !== undefined) {
      findings.push({
        source: source.source,
        kind: "source_error",
        detail: `last sync failed: ${source.last_error}`,
        suggestion: "check whether the endpoint moved or the response shape changed; repair discovery in the factory",
      });
    }
    if (source.records === 0) {
      findings.push({
        source: source.source,
        kind: "no_results",
        detail: "the source holds no records",
        suggestion: "discovery found nothing — the navigation or the feed URL is the first thing to check",
      });
      continue;
    }

    const before = previous.get(source.source);
    if (before === undefined) {
      findings.push({
        source: source.source,
        kind: "new_source",
        detail: `${source.records} record(s), ${(source.qa_rate * 100).toFixed(0)}% with question/answer pairs`,
        suggestion: "record this snapshot as the baseline once the numbers have been looked at",
      });
      continue;
    }

    if (source.abstention_rate - before.abstention_rate > ABSTENTION_SPIKE) {
      findings.push({
        source: source.source,
        kind: "abstention_spike",
        detail: `abstention rate rose from ${pct(before.abstention_rate)} to ${pct(source.abstention_rate)}`,
        suggestion: "the documents changed shape, not the site — regenerate the parse rules and re-run the goldens",
      });
    }
    if (before.qa_rate - source.qa_rate > QA_COLLAPSE) {
      findings.push({
        source: source.source,
        kind: "qa_collapse",
        detail: `question/answer rate fell from ${pct(before.qa_rate)} to ${pct(source.qa_rate)}`,
        suggestion: "the segmentation rules stopped recognising this source's headings",
      });
    }
    if (source.records < before.records) {
      findings.push({
        source: source.source,
        kind: "coverage_drop",
        detail: `record count fell from ${before.records} to ${source.records}`,
        suggestion: "records do not vanish on their own — check the corpus, then discovery",
      });
    }
  }

  for (const [key, before] of previous) {
    if (current.sources.some((source) => source.source === key)) continue;
    findings.push({
      source: key,
      kind: "coverage_drop",
      detail: `the source had ${before.records} record(s) in the baseline and none now`,
      suggestion: "the whole source disappeared from the corpus — check discovery and the store",
    });
  }

  return findings.sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : a.kind < b.kind ? -1 : 1));
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}
