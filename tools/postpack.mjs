// Undo what `prepack` materialised.
//
// `prepack` writes real copies of the workspace dependencies into this package's
// `node_modules`, because that is the only place npm will bundle them from. Left
// behind, those copies **shadow the workspace symlinks** for anything running
// inside the package — the integration suite resolves `connector-berlin` to a copy
// with no `fixtures/` and fails on a missing golden. So they are removed again as
// soon as the tarball exists. The package README, parked while the repository
// README stood in for it, goes back in place.
import { existsSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const target = join(root, "packages", "openka-cli");
rmSync(join(target, "node_modules"), { recursive: true, force: true });
for (const name of ["LICENSE", "LICENSING.md", "CONTRIBUTING.md", "DATA_LICENSE.md", "CONCEPT.md"]) {
  rmSync(join(target, name), { force: true });
}
const parked = join(target, "package-readme.parked.md");
if (existsSync(parked)) renameSync(parked, join(target, "README.md"));
console.log("postpack: removed the generated bundle and document copies, restored the package README");
