// The version stamp — checked against the manifest that is actually published.
//
// `PACKAGE_VERSION` is a literal, so nothing moves it but `tools/version.mjs`, which
// runs as the published package's `version` lifecycle script. This test used to
// live in lib-models and compare against *that* package's manifest, which no bump
// ever touches — it would have stayed green while the tarball said 0.0.2 and
// `ka --version` said 0.0.1.

import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("tools/version.mjs", () => {
  it("restamps the golden records' extractor_version from the old package version to the new", async () => {
    const tools = (await import(new URL("../../../../tools/version.mjs", import.meta.url).href)) as {
      restampFixtures: (root: string, from: string, to: string) => string[];
    };
    const root = mkdtempSync(join(tmpdir(), "openka-version-"));
    try {
      const dir = join(root, "packages", "connector-x", "fixtures", "x", "x-1-1");
      mkdirSync(dir, { recursive: true });
      mkdirSync(join(root, "packages", "lib-y"), { recursive: true });
      const stamp = (version: string): string => JSON.stringify({ extraction: { extractor_version: `pkg:${version}+extract:92e420073a5d` } });
      writeFileSync(join(dir, "meta.json"), stamp("0.9.0"));
      writeFileSync(join(dir, "record.json"), stamp("0.9.0"));
      writeFileSync(join(dir, "other.json"), stamp("0.9.0"));
      writeFileSync(join(root, "packages", "connector-x", "fixtures", "x", "pinned.json"), stamp("0.9.0"));
      mkdirSync(join(dir, "nested"));
      writeFileSync(join(dir, "nested", "record.json"), JSON.stringify({ extractor_version: "release-build-7" }));

      const changed = tools.restampFixtures(root, "0.9.0", "0.10.0");
      deepStrictEqual(changed.map((file) => file.slice(root.length + 1)).sort(), [join("packages", "connector-x", "fixtures", "x", "x-1-1", "meta.json"), join("packages", "connector-x", "fixtures", "x", "x-1-1", "record.json")]);
      strictEqual(readFileSync(join(dir, "meta.json"), "utf8"), stamp("0.10.0"));
      strictEqual(readFileSync(join(dir, "record.json"), "utf8"), stamp("0.10.0"));
      strictEqual(readFileSync(join(dir, "other.json"), "utf8"), stamp("0.9.0"), "only the golden files");
      strictEqual(readFileSync(join(dir, "nested", "record.json"), "utf8"), JSON.stringify({ extractor_version: "release-build-7" }), "a pinned build stamp stays");
      deepStrictEqual(tools.restampFixtures(root, "0.10.0", "0.10.0"), []);
      deepStrictEqual(tools.restampFixtures(root, "0.9.0", "0.10.0"), [], "nothing is left stamped with the old version");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
