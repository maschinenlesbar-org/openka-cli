// Everything the published tarball needs that the repository keeps elsewhere.
//
// `@maschinenlesbar.org/openka-cli` is a workspace package like every other, which
// keeps the layout free of exceptions — and costs one thing at publish time. npm
// bundles `bundleDependencies` from the *package's own* `node_modules`, and in a
// workspace the dependencies are symlinked into the **root** `node_modules`
// instead. Packing from the package therefore produces a tarball with none of them,
// and bins that cannot resolve a single import.
//
// So this materialises them: each workspace dependency's manifest and built `dist`
// are copied into `packages/openka-cli/node_modules/`, where npm will find and
// bundle them. It also copies the repository-level documents the tarball carries,
// because npm cannot reach outside a package directory when it builds one — the
// licence text among them, which npm only picks up from the package's own directory.
//
// The README is the one document that is swapped rather than added. npm shows the
// package directory's README.md on the registry page, and this package's own README
// is the packing guide for whoever maintains it. So the repository README takes its
// place for the length of the pack, and the package README waits beside it under a
// gitignored name until `postpack` puts it back.
//
// No source maps. `tsconfig.base.json` emits none — they would point at `src/*.ts`,
// which the tarball does not carry — and the copy below skips any that an older
// build left in a `dist/`.
//
// Everything written here is generated and gitignored. The originals stay the
// single source of truth.

import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const target = join(root, "packages", "openka-cli");
const manifest = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));

const DOCUMENTS = ["LICENSE", "LICENSING.md", "CONTRIBUTING.md", "DATA_LICENSE.md", "CONCEPT.md"];
for (const name of DOCUMENTS) cpSync(join(root, name), join(target, name));

// A pack that failed after this point never ran `postpack`: the package README is
// still waiting under its parked name. Put it back before parking it again, or the
// repository README would be parked over it and the original lost.
const readme = join(target, "README.md");
const parked = join(target, "package-readme.parked.md");
if (existsSync(parked)) renameSync(parked, readme);
renameSync(readme, parked);
cpSync(join(root, "README.md"), readme);

const scope = join(target, "node_modules", "@maschinenlesbar.org");
rmSync(join(target, "node_modules"), { recursive: true, force: true });
mkdirSync(scope, { recursive: true });

/**
 * Every workspace package the tarball needs, transitively.
 *
 * `dependencies` lists what this package imports directly; those import others.
 * Bundling only the direct ones leaves the bins unable to resolve half the graph,
 * which is a failure that shows up on a user's machine and nowhere earlier.
 */
function workspaceClosure(from) {
  const seen = new Set();
  const queue = [...from];
  while (queue.length > 0) {
    const name = queue.shift();
    if (!name.startsWith("@maschinenlesbar.org/") || seen.has(name)) continue;
    seen.add(name);
    const directory = name.replace("@maschinenlesbar.org/openka-", "");
    const file = join(root, "packages", directory, "package.json");
    if (!existsSync(file)) throw new Error(`${name} is not a workspace package`);
    queue.push(...Object.keys(JSON.parse(readFileSync(file, "utf8")).dependencies ?? {}));
  }
  return [...seen].sort();
}

const closure = workspaceClosure(Object.keys(manifest.dependencies ?? {}));
let bundled = 0;
for (const name of closure) {
  const directory = name.replace("@maschinenlesbar.org/openka-", "");
  const source = join(root, "packages", directory);
  if (!existsSync(join(source, "dist", "src"))) {
    throw new Error(`${name} has no dist/src — run the build before packing`);
  }
  const destination = join(scope, name.split("/")[1]);
  mkdirSync(destination, { recursive: true });
  cpSync(join(source, "package.json"), join(destination, "package.json"));
  cpSync(join(source, "dist", "src"), join(destination, "dist", "src"), {
    recursive: true,
    filter: (path) => !path.endsWith(".map"),
  });
  bundled += 1;
}

// The bundled copies must not claim devDependencies nobody is going to install.
// They do need to say whose they are and under what licence: a consumer's licence
// scanner or SBOM reads each bundled manifest on its own, and a workspace package
// carries neither field because it never ships alone.
for (const name of closure) {
  const file = join(scope, name.split("/")[1], "package.json");
  const packed = JSON.parse(readFileSync(file, "utf8"));
  delete packed.devDependencies;
  delete packed.scripts;
  packed.license = manifest.license;
  packed.author = manifest.author;
  packed.repository = {
    ...manifest.repository,
    directory: `packages/${name.replace("@maschinenlesbar.org/openka-", "")}`,
  };
  packed.homepage = manifest.homepage;
  writeFileSync(file, `${JSON.stringify(packed, null, 2)}\n`);
}

/**
 * Every third-party package the bundled graph needs at run time, transitively.
 *
 * These have to be bundled as well, not left to npm to install. A global install
 * (`npm install -g`) of a tarball whose bundled packages depend on `commander`
 * created `node_modules/commander` as an **empty directory**, counted the
 * dependency as satisfied, and every `ka` command then failed with
 * ERR_MODULE_NOT_FOUND (issue #1). A local install hoisted a real copy and hid it.
 * Bundling the whole runtime closure makes the tarball self-contained, which also
 * means an install needs nothing from the registry.
 */
function thirdPartyClosure(manifests) {
  const seen = new Set();
  const queue = manifests.flatMap((m) => Object.keys(m.dependencies ?? {}));
  while (queue.length > 0) {
    const name = queue.shift();
    if (name.startsWith("@maschinenlesbar.org/") || seen.has(name)) continue;
    seen.add(name);
    const file = join(root, "node_modules", name, "package.json");
    if (!existsSync(file)) throw new Error(`${name} is not installed — run npm ci before packing`);
    queue.push(...Object.keys(JSON.parse(readFileSync(file, "utf8")).dependencies ?? {}));
  }
  return [...seen].sort();
}

const thirdParty = thirdPartyClosure([
  manifest,
  ...closure.map((name) =>
    JSON.parse(readFileSync(join(root, "packages", name.replace("@maschinenlesbar.org/openka-", ""), "package.json"), "utf8")),
  ),
]);
for (const name of thirdParty) {
  cpSync(join(root, "node_modules", name), join(target, "node_modules", name), {
    recursive: true,
    dereference: true,
  });
}

// `bundleDependencies` has to name all of them, or npm packs none of them — and a
// third-party one missing from the list is the empty-directory bug above, so that
// is an error rather than something to patch into the manifest here.
const declared = new Set(manifest.bundleDependencies ?? []);
const undeclared = thirdParty.filter((name) => !declared.has(name));
if (undeclared.length > 0) {
  throw new Error(`bundleDependencies must name ${undeclared.join(", ")} (a runtime dependency of the bundled packages)`);
}
const missing = closure.filter((name) => !declared.has(name));
if (missing.length > 0) {
  writeFileSync(
    join(target, "package.json"),
    `${JSON.stringify({ ...manifest, bundleDependencies: [...closure, ...thirdParty] }, null, 2)}\n`,
  );
}

console.log(
  `prepack: ${DOCUMENTS.length} document(s), ${bundled} bundled package(s), ` +
    `${thirdParty.length} third-party (${thirdParty.join(", ")})` +
    (missing.length > 0 ? ` (added ${missing.length} transitive to bundleDependencies)` : ""),
);
