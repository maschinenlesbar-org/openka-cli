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
// because npm cannot reach outside a package directory when it builds one.
//
// Everything written here is generated and gitignored. The originals stay the
// single source of truth.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const target = join(root, "packages", "openka-cli");
const manifest = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));

const DOCUMENTS = ["LICENSING.md", "CONTRIBUTING.md", "DATA_LICENSE.md", "CONCEPT.md"];
for (const name of DOCUMENTS) cpSync(join(root, name), join(target, name));

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
  cpSync(join(source, "dist", "src"), join(destination, "dist", "src"), { recursive: true });
  bundled += 1;
}

// The bundled copies must not claim devDependencies nobody is going to install.
for (const name of closure) {
  const file = join(scope, name.split("/")[1], "package.json");
  const packed = JSON.parse(readFileSync(file, "utf8"));
  delete packed.devDependencies;
  delete packed.scripts;
  writeFileSync(file, `${JSON.stringify(packed, null, 2)}\n`);
}

// `bundleDependencies` has to name them too, or npm packs none of them.
const declared = new Set(manifest.bundleDependencies ?? []);
const missing = closure.filter((name) => !declared.has(name));
if (missing.length > 0) {
  writeFileSync(
    join(target, "package.json"),
    `${JSON.stringify({ ...manifest, bundleDependencies: closure }, null, 2)}\n`,
  );
}

console.log(
  `prepack: ${DOCUMENTS.length} document(s), ${bundled} bundled package(s)` +
    (missing.length > 0 ? ` (added ${missing.length} transitive to bundleDependencies)` : ""),
);
