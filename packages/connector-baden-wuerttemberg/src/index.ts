// Landtag Baden-Württemberg: no adapter of its own yet.
//
// The Land delivers to the Parlamentsspiegel, so it is reachable today through the
// shared aggregator — metadata and PDF links, no Land-specific handling. This
// package exists so that when baden-wuerttemberg gets its own adapter, there is already a
// place for it and for its tests, and so `ka sources list` can name the gap.

import { ParlamentsspiegelSource } from "@maschinenlesbar.org/openka-lib-parlamentsspiegel";
import type { Source, SourceEntry } from "@maschinenlesbar.org/openka-lib-source";

export const PARLIAMENT = "baden-wuerttemberg" as const;
export const LABEL = "Landtag Baden-Württemberg";
export const STATUS = "via_aggregator" as const;
export const NOTE =
  "no dedicated adapter yet — reachable through `--source parlamentsspiegel`, metadata plus PDF links only";

export function createSource(): Source {
  return new ParlamentsspiegelSource(PARLIAMENT);
}

/** How this connector announces itself to the registry and `ka sources list`. */
export const ENTRY: SourceEntry = {
  key: PARLIAMENT,
  parliament: PARLIAMENT,
  label: LABEL,
  status: STATUS,
  note: NOTE,
  factory: createSource,
};
