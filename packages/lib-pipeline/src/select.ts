// Which of the Anfragen a window holds a sync handles: `ka sync --ref`, `--retry-failed`
// and `--only-new` (issue #27).
//
// To fetch one Anfrage again — a timeout, a document over the old size cap, a link
// the portal glued together — the only way was to sync its whole window, which
// re-checks every stored Anfrage on the way: one request each, at Sachsen-Anhalt's 4 s
// floor about 15 a minute, so three hours to reach forty. Discovery still runs (a
// ref is what the source says about an Anfrage, and only the source can say it); the
// selection decides what happens next, and an Anfrage it leaves out costs nothing.

import { makeRecordId, parseReference, periodNumber, type KaRecord } from "@maschinenlesbar.org/openka-lib-models";
import type { DocRef, Source } from "@maschinenlesbar.org/openka-lib-source";
import type { FailedRef, SourceState, Store } from "@maschinenlesbar.org/openka-lib-store";
import type { SyncWindow } from "./window.js";

/**
 * Do two references name the same Drucksache? Compared as values where both parse,
 * so a Land that pads the period one day (`08/980`) and not the next (`8/980`) is
 * a correction of the same record, not a collision with another.
 */
export function sameReference(a: string, b: string): boolean {
  if (a === b) return true;
  const left = parseReference(a);
  const right = parseReference(b);
  if (left === undefined || right === undefined) return false;
  return periodNumber(left) === periodNumber(right) && left.number === right.number && left.prefix === right.prefix;
}

/** Whether `ref` is the Anfrage `reference` names: by its reference, or one it was filed under before. */
export function refIs(ref: DocRef, reference: string): boolean {
  return sameReference(reference, ref.reference) || (ref.formerly ?? []).some((former) => sameReference(reference, former));
}

export interface RefSelection {
  /** The refs to handle, in discovery order. */
  refs: DocRef[];
  /** Discovered, and left out by the selection. */
  skipped: number;
  warnings: string[];
}

/**
 * The refs of `discovered` a sync over `window` handles. `refs` and `retryFailed` each
 * name Anfragen, and a ref either names is taken; without them every ref is. `onlyNew`
 * then leaves out what the corpus holds complete (`isComplete`). A named reference the
 * window does not hold is a warning, never a silent no-op — the likeliest cause is a
 * window that misses it.
 */
export function selectRefs(
  discovered: readonly DocRef[],
  window: SyncWindow,
  context: { source: Source; store: Pick<Store, "getRecord">; state: SourceState },
): RefSelection {
  const warnings: string[] = [];
  let refs = [...discovered];
  const named = window.refs ?? [];
  const failed = window.retryFailed === true ? (context.state.failed ?? []) : [];
  if (window.retryFailed === true && failed.length === 0) {
    warnings.push(`--retry-failed: no failed Anfrage of ${context.source.key} is recorded, so there is nothing to retry`);
  }
  if (window.refs !== undefined || window.retryFailed === true) {
    refs = refs.filter((ref) => named.some((reference) => refIs(ref, reference)) || failed.some((entry) => refIs(ref, entry.reference)));
    const missing = named.filter((reference) => !discovered.some((ref) => refIs(ref, reference)));
    if (missing.length > 0) {
      warnings.push(`--ref: not in this window, so not synced: ${missing.join(", ")} — a window that holds them finds them`);
    }
    const elsewhere = failed.filter((entry) => !discovered.some((ref) => refIs(ref, entry.reference)));
    if (failed.length > 0 && elsewhere.length > 0) {
      warnings.push(
        `--retry-failed: ${elsewhere.length} failed Anfrage(n) of ${context.source.key} are not in this window: ` +
          `${elsewhere.map((entry) => entry.reference).join(", ")} — retry them with the window they were synced in`,
      );
    }
  }
  if (window.onlyNew === true) refs = refs.filter((ref) => !isComplete(ref, context.source, context.store));
  return { refs, skipped: discovered.length - refs.length, warnings };
}

/**
 * Whether the corpus holds `ref` with every document it lists archived — what
 * `--only-new` skips. A document matches by role and, where its URL is stable, by URL:
 * Sachsen's links expire and are new on every listing, and a stored record whose
 * document link was glued or over the size cap has no archived copy of it.
 */
export function isComplete(ref: DocRef, source: Pick<Source, "parliament">, store: Pick<Store, "getRecord">): boolean {
  const parliament = ref.parliament ?? source.parliament;
  if (parliament === undefined) return false;
  let record: KaRecord | undefined;
  try {
    record = store.getRecord(makeRecordId(parliament, ref.legislative_period, ref.reference));
  } catch {
    return false;
  }
  if (record === undefined) return false;
  const stored = record.source_documents;
  return ref.documents.every((wanted) =>
    stored.some((document) => document.role === wanted.role && document.sha256 !== undefined && (!wanted.urlStable || document.url === wanted.url)),
  );
}

/**
 * The failed list after one ref: gone once the ref was handled, recorded (or its error
 * replaced) when it failed again. Matched like `--retry-failed` matches.
 */
export function noteOutcome(failed: FailedRef[], ref: DocRef, error: string | undefined, at: string): FailedRef[] {
  const others = failed.filter((entry) => !refIs(ref, entry.reference));
  return error === undefined ? others : [...others, { reference: ref.reference, error, at }];
}
