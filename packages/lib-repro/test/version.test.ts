// The version stamp — checked against the manifest that is actually published.
//
// `PACKAGE_VERSION` is a literal, so nothing moves it but `tools/version.mjs`, which
// runs as the published package's `version` lifecycle script. This test used to
// live in lib-models and compare against *that* package's manifest, which no bump
// ever touches — it would have stayed green while the tarball said 0.0.2 and
// `ka --version` said 0.0.1.

import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { PACKAGE_VERSION } from "../src/index.js";

describe("PACKAGE_VERSION", () => {
  it("is the version of the package that is published", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../../../openka-cli/package.json", import.meta.url), "utf8"),
    ) as { name: string; version: string };
    strictEqual(manifest.name, "@maschinenlesbar.org/openka-cli");
    strictEqual(PACKAGE_VERSION, manifest.version);
  });
});
