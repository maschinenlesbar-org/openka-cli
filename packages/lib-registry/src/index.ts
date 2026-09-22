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
  PARLAMENTSSPIEGEL,
  BADEN_WUERTTEMBERG,
  BAYERN,
  BRANDENBURG,
  HAMBURG,
  HESSEN,
  RHEINLAND_PFALZ,
  SACHSEN_ANHALT,
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

/** Build a source, or throw with a message naming what is available. */
export function createSource(key: string): Source {
  const entry = BY_KEY.get(key);
  if (entry?.factory === undefined) {
    throw new Error(
      entry === undefined
        ? `Unknown source "${key}". Known sources: ${sourceKeys().join(", ")}.`
        : `Source "${key}" is registered but has no adapter yet (${entry.note}).`,
    );
  }
  return entry.factory();
}
