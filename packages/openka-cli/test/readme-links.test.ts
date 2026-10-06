// Conformance check P21 (follow-up round 2026-10-06): the README npm shows ships in the
// tarball, so every relative link in it must point to a file the package ships; any other
// document is linked by its absolute GitHub URL. For this package that README is the
// repository's: `tools/prepack.mjs` swaps it in for the length of the pack and copies the
// repository documents it carries (LICENSE, LICENSING.md, …) next to it, so a link's path
// relative to the repository root is its path in the tarball. Dependency-free: reads
// package.json `files` rather than running `npm pack`.

import { deepStrictEqual, ok } from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The compiled test runs from packages/openka-cli/dist/test/.
const pkgDir = fileURLToPath(new URL("../../", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const pkg = JSON.parse(readFileSync(pkgDir + "package.json", "utf8")) as { files?: string[] };
const readme = readFileSync(repoRoot + "README.md", "utf8");
const prepack = readFileSync(repoRoot + "tools/prepack.mjs", "utf8");

/** Relative link targets of the README, anchors and titles stripped. */
function relativeTargets(markdown: string): string[] {
  const targets: string[] = [];
  for (const m of markdown.matchAll(/\]\(\s*<?([^)\s>]*)>?(?:\s+"[^"]*")?\s*\)/g)) {
    const raw = m[1] ?? "";
    if (raw === "" || raw.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(raw)) continue;
    const path = decodeURIComponent(raw.split("#")[0]!.split("?")[0]!).replace(/^\.\//, "");
    if (path !== "") targets.push(path);
  }
  return targets;
}

/** A `files` entry as a test: a plain path, a directory prefix, or a simple `*` glob. */
function matcher(entry: string): (path: string) => boolean {
  const clean = entry.replace(/^\.\//, "").replace(/\/+$/, "");
  if (clean.includes("*")) {
    const source = clean
      .split(/(\*\*\/?|\*)/)
      .map((part) => (part.startsWith("**") ? ".*" : part === "*" ? "[^/]*" : part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")))
      .join("");
    const re = new RegExp(`^${source}(/.*)?$`);
    return (path) => re.test(path);
  }
  return (path) => path === clean || path.startsWith(clean + "/");
}

/** Whether npm packs `path`: always README, LICENSE/LICENCE and package.json, else `files`. */
function shipped(path: string): boolean {
  if (/^(README|LICEN[CS]E)(\.[^/]*)?$/i.test(path) || path === "package.json") return true;
  const entries = pkg.files ?? [];
  const included = entries.filter((e) => !e.startsWith("!")).some((e) => matcher(e)(path));
  const excluded = entries.filter((e) => e.startsWith("!")).some((e) => matcher(e.slice(1))(path));
  return included && !excluded;
}

describe("the README npm shows (P21)", () => {
  it("links relatively only to files the package ships", () => {
    const broken = relativeTargets(readme).filter((t) => !shipped(t));
    deepStrictEqual(
      broken.map((t) => `${t} -> https://github.com/maschinenlesbar-org/openka-cli/blob/main/${t}`),
      [],
      "README.md links to files the npm package doesn't ship; use the absolute GitHub URL shown",
    );
  });

  it("is the repository README, and prepack copies every shipped document it links", () => {
    ok(/cpSync\(join\(root, "README\.md"\), readme\)/.test(prepack), "prepack no longer swaps in the repository README");
    for (const target of relativeTargets(readme)) {
      if (/^(README|LICEN[CS]E)/i.test(target) || target.startsWith("dist/")) continue;
      ok(prepack.includes(`"${target}"`), `${target} is in files but prepack does not copy it into the package`);
    }
    // A README without relative links would pass the first check vacuously.
    ok(relativeTargets(readme).includes("DATA_LICENSE.md"));
  });
});
