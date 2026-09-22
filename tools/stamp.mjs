// Regenerate the frozen extraction digest. Run after changing extraction code:
//   npm run stamp
//
// It imports the computation from the built factory, so `npm run build` runs first
// (the `stamp` script chains it). The digest itself is not needed to build.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { computeExtractionDigest, extractionSourceFiles } from "../dist/src/factory/lib/stamp.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const target = join(root, "src/core/repro/extraction-digest.ts");
const digest = computeExtractionDigest(root);
const before = readFileSync(target, "utf8");
const after = before.replace(/export const EXTRACTION_DIGEST = "[0-9a-f]*";/, `export const EXTRACTION_DIGEST = "${digest}";`);
if (after === before) {
  console.log(`extraction digest unchanged: ${digest} (${extractionSourceFiles(root).length} file(s))`);
} else {
  writeFileSync(target, after);
  console.log(`extraction digest updated to ${digest} (${extractionSourceFiles(root).length} file(s)) — re-freeze the goldens`);
}
