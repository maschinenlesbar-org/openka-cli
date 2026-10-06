// The source registry: every parliament OpenKA covers, and the honest state of its
// adapter.
//
// All 17 are listed, including the ones with no adapter of their own yet. That is
// deliberate — `ka sources list` should show the whole map with the gaps visible,
// because a silent absence looks exactly like a source that found nothing, and the
// difference matters to anyone deciding whether the corpus can answer their
// question.
//
// This package only collects. Each connector declares its own `ENTRY` — its key,
// label, status, note and how to build it — so a Land's description lives with the
// Land's code, and adding a parliament means adding a package and one line here.

import { ParlamentsspiegelAllLaender } from "@maschinenlesbar.org/openka-lib-parlamentsspiegel";
import type { Source, SourceEntry } from "@maschinenlesbar.org/openka-lib-source";
import { OpenKaError, assertValid, nonBlankProblem, type Problem } from "@maschinenlesbar.org/openka-lib-errors";

import { ENTRY as BADEN_WUERTTEMBERG } from "@maschinenlesbar.org/openka-connector-baden-wuerttemberg";
import { ENTRY as BAYERN } from "@maschinenlesbar.org/openka-connector-bayern";
import { ENTRY as BERLIN } from "@maschinenlesbar.org/openka-connector-berlin";
import { ENTRY as BRANDENBURG } from "@maschinenlesbar.org/openka-connector-brandenburg";
import { ENTRY as BREMEN } from "@maschinenlesbar.org/openka-connector-bremen";
import { ENTRY as BUND } from "@maschinenlesbar.org/openka-connector-bund";
import { ENTRY as HAMBURG } from "@maschinenlesbar.org/openka-connector-hamburg";
import { ENTRY as HESSEN } from "@maschinenlesbar.org/openka-connector-hessen";
import { ENTRY as MECKLENBURG_VORPOMMERN } from "@maschinenlesbar.org/openka-connector-mecklenburg-vorpommern";
import { ENTRY as NIEDERSACHSEN } from "@maschinenlesbar.org/openka-connector-niedersachsen";
import { ENTRY as NORDRHEIN_WESTFALEN } from "@maschinenlesbar.org/openka-connector-nordrhein-westfalen";
import { ENTRY as RHEINLAND_PFALZ } from "@maschinenlesbar.org/openka-connector-rheinland-pfalz";
import { ENTRY as SAARLAND } from "@maschinenlesbar.org/openka-connector-saarland";
import { ENTRY as SACHSEN } from "@maschinenlesbar.org/openka-connector-sachsen";
import { ENTRY as SACHSEN_ANHALT } from "@maschinenlesbar.org/openka-connector-sachsen-anhalt";
import { ENTRY as SCHLESWIG_HOLSTEIN } from "@maschinenlesbar.org/openka-connector-schleswig-holstein";
import { ENTRY as THUERINGEN } from "@maschinenlesbar.org/openka-connector-thueringen";

export type { SourceEntry, SourceStatus } from "@maschinenlesbar.org/openka-lib-source";

/** The aggregator itself, which belongs to no single parliament. */
const PARLAMENTSSPIEGEL: SourceEntry = {
  key: "parlamentsspiegel",
  label: "Parlamentsspiegel (all 16 Länder)",
  status: "implemented",
  note: "HTML search of the Länder's shared portal; metadata and PDF links for every Land",
  factory: () => new ParlamentsspiegelAllLaender(),
};

export const SOURCE_REGISTRY: readonly SourceEntry[] = [
  BUND,
  BERLIN,
  NORDRHEIN_WESTFALEN,
  SAARLAND,
  SACHSEN,
  THUERINGEN,
  NIEDERSACHSEN,
  MECKLENBURG_VORPOMMERN,
  BREMEN,
  BAYERN,
  BRANDENBURG,
  SACHSEN_ANHALT,
  PARLAMENTSSPIEGEL,
  BADEN_WUERTTEMBERG,
  HAMBURG,
  HESSEN,
  RHEINLAND_PFALZ,
  SCHLESWIG_HOLSTEIN,
];

const BY_KEY = new Map(SOURCE_REGISTRY.map((entry) => [entry.key, entry]));

export function sourceEntry(key: string): SourceEntry | undefined {
  return BY_KEY.get(key);
}

/** Every registered key, sorted — what `--source` accepts. */
export function sourceKeys(): string[] {
  return [...BY_KEY.keys()].sort();
}

/**
 * Every source with an adapter of its own — implemented and pinned to one
 * parliament — in registry order: what `ka sync --all` runs. The Parlamentsspiegel
 * aggregator is not among them. It files records under the same ids as the Länder
 * it covers, so running it next to their own adapters would overwrite their
 * records with its metadata-and-links ones; it is named on its own when wanted.
 */
export function adapterSourceKeys(): string[] {
  return SOURCE_REGISTRY.filter(
    (entry) => entry.status === "implemented" && entry.parliament !== undefined && entry.factory !== undefined,
  ).map((entry) => entry.key);
}

/**
 * Why `key` names no registered source, or `undefined` when it does. Keys are
 * matched exactly: "Bund" and " bund" are unknown, and the reason lists every key
 * there is. A blank key is blank, as everywhere else.
 */
export const sourceKeyProblem: Problem<string> = (key) =>
  nonBlankProblem(key) ??
  (BY_KEY.has(key) ? undefined : `Unknown source "${key}". Known sources: ${sourceKeys().join(", ")}.`);

/**
 * Build a source. An unknown key throws `OpenKaValidationError` ("Invalid source:
 * Unknown source …", `sourceKeyProblem`) before anything is built; a registered key
 * with no adapter an `OpenKaError`.
 */
export function createSource(key: string): Source {
  assertValid("source", key, sourceKeyProblem);
  const entry = BY_KEY.get(key);
  if (entry?.factory === undefined) {
    throw new OpenKaError(`Source "${key}" is registered but has no adapter yet (${entry?.note ?? "no note"}).`);
  }
  return entry.factory();
}
