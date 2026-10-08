// `ka reextract` — bring stored records up to this build's extractor, offline.
//
// After an upgrade every record carried the old extractor's stamp, `ka verify`
// failed on all of them, and the only way to the new extractor was `ka sync
// --force` over the windows synced before: discovery, the network, and knowing which
// windows those were (issue #13). The documents are archived, so a record can be
// re-extracted from its own bytes, with its own metadata, without a request.

import { withCorpusLock, reindexAll } from "@maschinenlesbar.org/openka-lib-store";
import { currentReference, makeRecordId, type KaRecord } from "@maschinenlesbar.org/openka-lib-models";
import { StoreError } from "@maschinenlesbar.org/openka-lib-errors";
import { canonicalJsonLine, extractorVersion } from "@maschinenlesbar.org/openka-lib-repro";
import { VERSION_PATH, diffPaths, reextractStored, type VerifyOptions } from "./index.js";

/**
 * What became of one record:
 * - `current` — stamped by this build already; left alone (without `force`);
 * - `identical` — re-extracted, and nothing at all moved;
 * - `unchanged-content` — only the version stamp moves;
 * - `changed` — the content moves too (`differences`), with what it resolved and what
 *   it newly abstains on;
 * - `unreadable` — the record or its archived bytes could not be read;
 * - `unchecked` — not re-extracted: an OCR record without its model;
 * - `duplicate` — a copy an earlier build stored under another paper's id of a record
 *   stored under its own already (`movedTo`); it is removed.
 */
export type ReextractOutcome = "current" | "identical" | "unchanged-content" | "changed" | "unreadable" | "unchecked" | "duplicate";

export interface ReextractResult {
  id: string;
  outcome: ReextractOutcome;
  storedVersion: string;
  /** The content paths that move (the version stamp left out). */
  differences: string[];
  /** Abstained fields the new extraction fills: in the stored record's list, not in the new one's. */
  resolved: string[];
  /** Abstained fields the new extraction adds. */
  abstained: string[];
  /**
   * The Q/A before and after, compared by question number rather than by index: a new
   * reading that finds one more pair shifts every `qa[n]` after it, and `resolved` /
   * `abstained` then name fields that only moved (issue #26). Set for `changed`.
   */
  qa?: QaChange;
  /** A `human_verified` mark that went, since what the person checked changed. */
  droppedMark?: true;
  /**
   * The id the record has under this build's rules, when it differs from `id`
   * (`currentReference`, issue #25): the record moves there, or — when a record of that
   * id is stored already — the stale copy under `id` is removed (`duplicate`).
   */
  movedTo?: string;
  duplicate?: true;
  reason?: string;
}

/** How many pairs, questions and answers a record reads. */
export interface QaCounts {
  pairs: number;
  questions: number;
  answers: number;
}

export interface QaChange {
  before: QaCounts;
  after: QaCounts;
  /** By number, what is read now and was not: `17.question`, `9b.answer`, `9b` for a new pair. */
  gained: string[];
  /** By number, what was read and is not any more. */
  lost: string[];
}

/** The Q/A of `before` and `after`, compared by question number. */
export function compareQa(before: KaRecord, after: KaRecord): QaChange {
  const counts = (record: KaRecord): QaCounts => ({
    pairs: record.qa.length,
    questions: record.qa.filter((pair) => pair.question !== undefined).length,
    answers: record.qa.filter((pair) => pair.answer !== undefined).length,
  });
  // A number that appears twice is told apart by its order: `1`, `1#2`.
  const byNumber = (record: KaRecord): Map<string, { question: boolean; answer: boolean }> => {
    const out = new Map<string, { question: boolean; answer: boolean }>();
    for (const pair of record.qa) {
      let key = pair.number;
      for (let n = 2; out.has(key); n++) key = `${pair.number}#${n}`;
      out.set(key, { question: pair.question !== undefined, answer: pair.answer !== undefined });
    }
    return out;
  };
  const old = byNumber(before);
  const now = byNumber(after);
  const gained: string[] = [];
  const lost: string[] = [];
  for (const [number, pair] of now) {
    const was = old.get(number);
    if (was === undefined) gained.push(number);
    if (pair.question && was?.question !== true) gained.push(`${number}.question`);
    if (pair.answer && was?.answer !== true) gained.push(`${number}.answer`);
  }
  for (const [number, pair] of old) {
    const is = now.get(number);
    if (is === undefined) lost.push(number);
    if (pair.question && is?.question !== true) lost.push(`${number}.question`);
    if (pair.answer && is?.answer !== true) lost.push(`${number}.answer`);
  }
  return { before: counts(before), after: counts(after), gained, lost };
}

export interface ReextractOptions extends VerifyOptions {
  /** The records to re-extract. */
  ids: readonly string[];
  /** Also the records this build stamped already. */
  force?: boolean;
  /** Report what would change and write nothing. */
  dryRun?: boolean;
  /** After each record, for a progress display. */
  onProgress?: (done: number, total: number) => void;
}

export interface ReextractReport {
  /** This build's extractor version: what the records are stamped with now. */
  currentVersion: string;
  dryRun: boolean;
  checked: number;
  /** Records written (none on a dry run). */
  written: number;
  /** Records that moved to the id this build gives them, or went as a stale copy of one stored there (`movedTo`). */
  moved: number;
  /** Whether the index and catalog were rebuilt afterwards. */
  reindexed: boolean;
  counts: Record<ReextractOutcome, number>;
  results: ReextractResult[];
}

/**
 * Re-extract `ids` from their archived bytes and store what moved, then rebuild the
 * index and catalog from the records (`reindexAll`). Holds the corpus lock while it
 * writes; a dry run takes no lock and writes nothing. No request is made.
 *
 * A record re-extracts with the metadata it carries (`UNCHECKED_FIELDS`), so only
 * what the extractor derives from the documents can move. A `human_verified` mark
 * stays when the content did not move, and goes (`droppedMark`) when it did, since
 * what the person checked is not what the record now says.
 */
export async function reextractRecords(options: ReextractOptions): Promise<ReextractReport> {
  const { store } = options;
  store.assertBlobStore?.();
  const run = async (): Promise<ReextractReport> => {
    const currentVersion = extractorVersion(options.env);
    const counts: Record<ReextractOutcome, number> = { current: 0, identical: 0, "unchanged-content": 0, changed: 0, unreadable: 0, unchecked: 0, duplicate: 0 };
    const results: ReextractResult[] = [];
    let written = 0;
    let moved = 0;
    for (const [index, id] of options.ids.entries()) {
      const result = await reextractOne(id, currentVersion, options);
      if (result.result.movedTo !== undefined) moved++;
      if (options.dryRun !== true) {
        if (result.write !== undefined && result.result.duplicate !== true) {
          store.putRecord(result.write);
          written++;
        }
        // The record now lives under its new id (or there already); the old file goes.
        if (result.result.movedTo !== undefined) store.deleteRecord(id);
      }
      counts[result.result.outcome]++;
      results.push(result.result);
      options.onProgress?.(index + 1, options.ids.length);
    }
    // The catalog rows and postings are the old records'; a full rebuild is what
    // `ka reindex` does, and it is the one path known to leave them consistent.
    const reindexed = options.dryRun !== true && (written > 0 || moved > 0);
    if (reindexed) reindexAll(store);
    return { currentVersion, dryRun: options.dryRun === true, checked: results.length, written, moved, reindexed, counts, results };
  };
  return options.dryRun === true ? run() : withCorpusLock(store, "reextract", run);
}

async function reextractOne(
  id: string,
  currentVersion: string,
  options: ReextractOptions,
): Promise<{ result: ReextractResult; write?: KaRecord }> {
  const empty = { differences: [], resolved: [], abstained: [] };
  let stored: KaRecord | undefined;
  try {
    stored = options.store.getRecord(id);
  } catch (err) {
    if (!(err instanceof StoreError)) throw err;
    return { result: { id, outcome: "unreadable", storedVersion: "unknown", reason: err.message, ...empty } };
  }
  if (stored === undefined) return { result: { id, outcome: "unreadable", storedVersion: "", reason: "no such record", ...empty } };
  const storedVersion = stored.extraction.extractor_version;
  // A record an earlier build filed under a reference this one reads differently moves,
  // whatever its stamp: under its old id it holds the place of another paper.
  const reference = currentReference({ parliament: stored.parliament, reference: stored.reference, ...stored.dates });
  const movedTo = reference === undefined ? undefined : makeRecordId(stored.parliament, stored.legislative_period, reference);
  if (movedTo !== undefined && options.store.hasRecord(movedTo)) {
    return { result: { id, outcome: "duplicate", storedVersion, movedTo, duplicate: true, ...empty } };
  }
  if (movedTo === undefined && options.force !== true && storedVersion === currentVersion) return { result: { id, outcome: "current", storedVersion, ...empty } };

  const fresh = await reextractStored(reference === undefined ? stored : { ...stored, reference, id: movedTo as string }, options, { keepMark: false });
  if ("unreadable" in fresh) return { result: { id, outcome: "unreadable", storedVersion, reason: fresh.reason, ...empty } };
  if ("unchecked" in fresh) return { result: { id, outcome: "unchecked", storedVersion, reason: fresh.reason, ...empty } };
  const record = fresh.record;

  const content = (): string[] =>
    diffPaths(stored as unknown as Record<string, unknown>, record as unknown as Record<string, unknown>).filter((path) => path !== VERSION_PATH);
  // A person's mark stays where nothing they checked moved, and goes where it did.
  let droppedMark = false;
  if (stored.extraction.review_status === "human_verified") {
    // A move changes the record's name, not what the person checked.
    const moves = new Set(["extraction.review_status", ...(movedTo === undefined ? [] : ["id", "reference"])]);
    if (content().every((path) => moves.has(path))) record.extraction.review_status = "human_verified";
    else droppedMark = true;
  }
  const differences = content();
  if (canonicalJsonLine(stored) === canonicalJsonLine(record)) return { result: { id, outcome: "identical", storedVersion, ...empty } };
  const before = new Set(stored.extraction.abstained_fields);
  const after = new Set(record.extraction.abstained_fields);
  const result: ReextractResult = {
    id,
    outcome: differences.length === 0 ? "unchanged-content" : "changed",
    storedVersion,
    differences,
    resolved: [...before].filter((field) => !after.has(field)),
    abstained: [...after].filter((field) => !before.has(field)),
    ...(droppedMark ? { droppedMark: true as const } : {}),
    ...(movedTo === undefined ? {} : { movedTo }),
    ...(differences.some((path) => path === "qa" || path.startsWith("qa[") || path.startsWith("qa.")) ? { qa: compareQa(stored, record) } : {}),
  };
  return { result, write: record };
}
