// Keep the version constant in step with the published package's manifest.
//
// `npm version --workspace @maschinenlesbar.org/openka-cli` rewrites that one
// package.json and nothing else. `PACKAGE_VERSION` in lib-repro is what `ka
// --version` prints and what `extractor_version` stamps into every record, so it
// has to move with the manifest — and it is a literal, because the line does not
// read a manifest at run time. This runs as that package's `version` lifecycle
// script (after the bump, before npm's commit) and stages the file it changed.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = join(root, "packages", "openka-cli", "package.json");
const target = join(root, "packages", "lib-repro", "src", "version.ts");

const { version } = JSON.parse(readFileSync(manifest, "utf8"));
if (typeof version !== "string" || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  throw new Error(`${manifest} carries no usable version: ${String(version)}`);
}
const before = readFileSync(target, "utf8");
const after = before.replace(/export const PACKAGE_VERSION = "[^"]*";/, `export const PACKAGE_VERSION = "${version}";`);
if (after === before) {
  console.log(`version: PACKAGE_VERSION already ${version}`);
} else {
  writeFileSync(target, after);
  // Staged so that npm's own version commit carries it. Without a git repository
  // (a tarball, a CI checkout without .git) the write alone is what matters.
  try {
    execFileSync("git", ["add", "--", relative(root, target)], { cwd: root, stdio: "ignore" });
  } catch {
    // not a repository, or git is absent — the file is updated either way
  }
  console.log(`version: PACKAGE_VERSION ${version} (was ${/"([^"]*)"/.exec(before.match(/PACKAGE_VERSION = "[^"]*"/)?.[0] ?? '""')?.[1]})`);
}
