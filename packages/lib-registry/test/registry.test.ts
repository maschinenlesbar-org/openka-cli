// The registry: every parliament is listed, each connector's own entry is picked
// up, and a key that has no adapter says so rather than failing silently.

import { match, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { SOURCE_REGISTRY, createSource, sourceEntry, sourceKeys } from "../src/index.js";
import { PARLIAMENTS } from "@maschinenlesbar.org/openka-lib-models";

describe("source registry", () => {
  it("gives every adapter the key the registry lists it under", () => {
    // The pipeline persists sync state under `source.key`; `ka sources list` and
    // the health report read it back by the registry key. When they disagreed,
    // every aggregator-backed Land reported "never synced" right after a sync.
    for (const entry of SOURCE_REGISTRY) {
      if (entry.factory === undefined) continue;
      strictEqual(createSource(entry.key).key, entry.key, `adapter key differs for ${entry.key}`);
    }
  });
});

describe("source registry", () => {
  it("registers all 17 parliaments plus the aggregator", () => {
    // Counted on entries that name a parliament. This used to count the whole
    // registry and still come to 17, because the aggregator's placeholder
    // `parliament` collided with the Land it was borrowed from — the test was
    // relying on the very confusion that put a Land's record count under the
    // aggregator's row.
    const named = new Set(SOURCE_REGISTRY.map((entry) => entry.parliament).filter((key) => key !== undefined));
    strictEqual(named.size, PARLIAMENTS.length);
    ok(sourceKeys().includes("parlamentsspiegel"));
  });

  it("gives the all-Länder adapter no parliament of its own", () => {
    strictEqual(sourceEntry("parlamentsspiegel")?.parliament, undefined);
    strictEqual(createSource("parlamentsspiegel").parliament, undefined);
    // A Land-pinned instance still names one.
    strictEqual(createSource("hamburg").parliament, "hamburg");
  });

  it("marks the parliaments with no dedicated adapter honestly", () => {
    // What is left on the aggregator is now the Länder whose own interface has not
    // been reached: the three ESearch portals, and Hamburg while its Parldok is
    // down. Brandenburg and Sachsen-Anhalt are `implemented` but produce nothing
    // without `--ignore-robots`, which is a different kind of gap and is why their
    // notes say so rather than their status.
    strictEqual(sourceEntry("hessen")?.status, "via_aggregator");
    strictEqual(sourceEntry("baden-wuerttemberg")?.status, "via_aggregator");
    ok(sourceEntry("brandenburg")?.note.includes("--ignore-robots"));
    ok(sourceEntry("sachsen-anhalt")?.note.includes("--ignore-robots"));
    strictEqual(sourceEntry("thueringen")?.status, "implemented");
    strictEqual(sourceEntry("niedersachsen")?.status, "implemented");
    strictEqual(sourceEntry("berlin")?.status, "implemented");
    strictEqual(sourceEntry("sachsen")?.status, "implemented");
  });

  it("builds a source for every registered key", () => {
    for (const key of sourceKeys()) ok(createSource(key).key.length > 0);
  });

  it("names the alternatives when a key is unknown", () => {
    let message = "";
    try {
      createSource("atlantis");
    } catch (err) {
      message = err instanceof Error ? err.message : "";
    }
    match(message, /Known sources:/);
  });
});

describe("every connector's own entry", () => {
  // Each connector declares its `ENTRY` beside its code, and this is where that
  // claim is checked — the connectors cannot check it themselves, because the
  // registry depends on them and the arrow cannot point both ways.
  const IMPLEMENTED = [
    "bund",
    "berlin",
    "niedersachsen",
    "nordrhein-westfalen",
    "saarland",
    "sachsen",
    "thueringen",
    "mecklenburg-vorpommern",
    "bremen",
    "bayern",
    "brandenburg",
    "sachsen-anhalt",
  ];
  const VIA_AGGREGATOR = [
    "baden-wuerttemberg",
    "hamburg",
    "hessen",
    "rheinland-pfalz",
    "schleswig-holstein",
  ];

  it("registers every Land that has an adapter of its own", () => {
    for (const key of IMPLEMENTED) {
      strictEqual(sourceEntry(key)?.status, "implemented", key);
      ok(sourceEntry(key)?.factory !== undefined, `${key} has no factory`);
    }
  });

  it("registers every Land that has none, so the gap is visible", () => {
    for (const key of VIA_AGGREGATOR) {
      strictEqual(sourceEntry(key)?.status, "via_aggregator", key);
    }
  });

  it("covers all sixteen Länder and the Bund, plus the aggregator itself", () => {
    strictEqual(new Set([...IMPLEMENTED, ...VIA_AGGREGATOR]).size, 17);
    strictEqual(sourceKeys().length, 18);
  });
});
