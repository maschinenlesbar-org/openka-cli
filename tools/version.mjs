// Keep the version constant in step with the published package's manifest.
//
// `npm version --workspace @maschinenlesbar.org/openka-cli` rewrites that one
// package.json and nothing else. `PACKAGE_VERSION` in lib-repro is what `ka
// --version` prints and what `extractor_version` stamps into every record, so it
// has to move with the manifest — and it is a literal, because the line does not
// read a manifest at run time. This runs as that package's `version` lifecycle
// script (after the bump, before npm's commit) and stages the files it changed.
//
// The golden fixtures carry that stamp too (`pkg:<version>+extract:<digest>` in
// every `meta.json` and `record.json`), and `release.yml`'s tests compare it with
// the new version, so the same run restamps them: `pkg:<old>+extract:` becomes
// `pkg:<new>+extract:`, and the version commit carries both.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The `meta.json` and `record.json` files under every `packages/<name>/fixtures`. */
function goldenRecords(root) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else if (entry.name === "meta.json" || entry.name === "record.json") found.push(join(dir, entry.name));
    }
  };
  for (const pkg of readdirSync(join(root, "packages"), { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    try {
      walk(join(root, "packages", pkg.name, "fixtures"));
    } catch (err) {
      if (err?.code !== "ENOENT") throw err;
    }
  }
  return found;
}

/**
 * Restamp the golden records' `extractor_version` from `pkg:<from>+extract:` to
 * `pkg:<to>+extract:` and return the files that changed (absolute paths). A record
 * stamped with another version, or with a pinned `OPENKA_EXTRACTOR_VERSION`, is left as
 * it is.
 */
export function restampFixtures(root, from, to) {
  if (from === to) return [];
  const oldStamp = `pkg:${from}+extract:`;
  const changed = [];
  for (const file of goldenRecords(root)) {
    const before = readFileSync(file, "utf8");
    if (!before.includes(oldStamp)) continue;
    writeFileSync(file, before.split(oldStamp).join(`pkg:${to}+extract:`));
    changed.push(file);
  }
  return changed;
}

function main() {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const manifest = join(root, "packages", "openka-cli", "package.json");
  const target = join(root, "packages", "lib-repro", "src", "version.ts");

  const { version } = JSON.parse(readFileSync(manifest, "utf8"));
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
    throw new Error(`${manifest} carries no usable version: ${String(version)}`);
  }
  const before = readFileSync(target, "utf8");
  const was = /PACKAGE_VERSION = "([^"]*)"/.exec(before)?.[1];
  const after = before.replace(/export const PACKAGE_VERSION = "[^"]*";/, `export const PACKAGE_VERSION = "${version}";`);
  const changed = [];
  if (after === before) {
    console.log(`version: PACKAGE_VERSION already ${version}`);
  } else {
    writeFileSync(target, after);
    changed.push(target);
    console.log(`version: PACKAGE_VERSION ${version} (was ${was})`);
  }
  if (was !== undefined) {
    const stamped = restampFixtures(root, was, version);
    changed.push(...stamped);
    if (stamped.length > 0) console.log(`version: ${stamped.length} golden record file(s) restamped pkg:${was} -> pkg:${version}`);
  }
  // Staged so that npm's own version commit carries them. Without a git repository
  // (a tarball, a CI checkout without .git) the writes alone are what matter.
  try {
    execFileSync("git", ["add", "--", ...changed.map((file) => relative(root, file))], { cwd: root, stdio: "ignore" });
  } catch {
    // not a repository, or git is absent — the files are updated either way
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
