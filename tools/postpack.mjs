// Undo what `prepack` materialised.
//
// `prepack` writes real copies of the workspace dependencies into this package's
// `node_modules`, because that is the only place npm will bundle them from. Left
// behind, those copies **shadow the workspace symlinks** for anything running
// inside the package — the integration suite resolves `connector-berlin` to a copy
// with no `fixtures/` and fails on a missing golden. So they are removed again as
// soon as the tarball exists.
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const target = join(root, "packages", "openka-cli");
rmSync(join(target, "node_modules"), { recursive: true, force: true });
for (const name of ["LICENSING.md", "CONTRIBUTING.md", "DATA_LICENSE.md", "CONCEPT.md"]) {
  rmSync(join(target, name), { force: true });
}
console.log("postpack: removed the generated bundle and document copies");
