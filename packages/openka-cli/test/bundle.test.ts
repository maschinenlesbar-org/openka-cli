// Issue #1: `npm install -g` of the 0.2.0 tarball left `node_modules/commander` an
// empty directory, and every `ka` command crashed with ERR_MODULE_NOT_FOUND. The
// bundled workspace packages depend on `commander`, but `commander` itself was not
// bundled, and a global install created its folder without filling it. The tarball is
// self-contained now: every third-party runtime dependency of any workspace package is
// in `bundleDependencies`, and `tools/prepack.mjs` copies it in (and refuses to pack
// when one is missing). This keeps the manifest honest without running `npm pack`.

import { deepStrictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The compiled test runs from packages/openka-cli/dist/test/.
const pkgDir = fileURLToPath(new URL("../../", import.meta.url));
const packagesDir = fileURLToPath(new URL("../../../", import.meta.url));

interface Manifest {
  private?: boolean;
  dependencies?: Record<string, string>;
  bundleDependencies?: string[];
}

const read = (file: string): Manifest => JSON.parse(readFileSync(file, "utf8")) as Manifest;

describe("the published tarball is self-contained", () => {
  it("bundles every third-party runtime dependency of the workspace", () => {
    const published = read(pkgDir + "package.json");
    const thirdParty = new Set<string>();
    for (const dir of readdirSync(packagesDir)) {
      if (dir === "lib-testing") continue; // test helpers, never on the line
      const manifest = read(`${packagesDir}${dir}/package.json`);
      for (const name of Object.keys(manifest.dependencies ?? {})) {
        if (!name.startsWith("@maschinenlesbar.org/")) thirdParty.add(name);
      }
    }
    const bundled = new Set(published.bundleDependencies ?? []);
    deepStrictEqual(
      [...thirdParty].filter((name) => !bundled.has(name)),
      [],
      "a runtime dependency that is not bundled is installed empty by `npm install -g`",
    );
  });
});
