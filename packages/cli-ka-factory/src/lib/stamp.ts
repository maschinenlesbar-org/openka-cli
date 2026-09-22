// Computing the extraction digest that `extractor_version` carries.
//
// The stamp on a record has to identify the code that produced it, or "same
// extractor_version + same input_sha256 => same bytes" is not a checkable claim.
// An earlier attempt hashed the *named* frozen rules — the rule families, the
// guards, the two layout constants — which is what CLAUDE.md says changes record
// bytes. It was not enough: keeping control characters out of record text changed
// what every extraction produces and moved nothing, because the change was in
// ordinary code rather than in a named constant.
//
// So the digest covers the extraction sources themselves, and two decisions about
// *how* matter more than the hashing does:
//
//   - **TypeScript sources, not compiled output.** Hashing `dist` would make a
//     `tsc` upgrade rewrite the stamp of every record in every corpus, for a
//     change that cannot alter a single byte of extracted text.
//   - **Comments stripped.** `ka verify` compares `extractor_version`, so every
//     stored record "fails" verification until it is re-synced whenever the stamp
//     moves. This codebase is deliberately comment-heavy; making an improved
//     comment invalidate a corpus would teach people not to write them.
//
// This lives in the factory because it reads the source tree, which is a
// build-time act. The line only ever sees the frozen constant it produces.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { stripComments } from "./lint.js";

/**
 * The code that decides what a document turns into.
 *
 * `core/extract` and `core/pdf` are the tier stack and the reader it runs on;
 * `core/perceive` is the OCR path, whose output is record text like any other;
 * `core/text.ts` normalises what all of them produce. `core/repro` is deliberately
 * absent — the generated digest lives there, and hashing it would chase its own
 * tail.
 */
export const EXTRACTION_SOURCES = [
  "packages/lib-extract/src",
  "packages/lib-pdf/src",
  "packages/lib-perceive/src",
  "packages/lib-text/src",
] as const;

/** Every `.ts` file under a root, sorted, as project-relative POSIX paths. */
function filesUnder(projectRoot: string, entry: string): string[] {
  const absolute = join(projectRoot, entry);
  let stats;
  try {
    stats = statSync(absolute);
  } catch {
    return [];
  }
  if (stats.isFile()) return entry.endsWith(".ts") ? [entry] : [];
  const out: string[] = [];
  for (const name of readdirSync(absolute).sort()) {
    out.push(...filesUnder(projectRoot, join(entry, name)));
  }
  return out;
}

/**
 * Normalise a source file to the part that can change behaviour: comments gone,
 * every line trimmed, blank lines dropped. Re-indenting a block or reflowing a
 * comment therefore leaves the digest alone; changing a token does not.
 */
function behaviourBearingSource(source: string): string {
  return stripComments(source)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join("\n");
}

/** The files the digest covers, in the order they are hashed. */
export function extractionSourceFiles(projectRoot: string): string[] {
  const files: string[] = [];
  for (const entry of EXTRACTION_SOURCES) files.push(...filesUnder(projectRoot, entry));
  return files.map((file) => file.split(sep).join("/")).sort();
}

/**
 * Twelve hex characters over the normalised extraction sources. The path is hashed
 * with the contents, so moving a rule to a new file counts as a change.
 */
export function computeExtractionDigest(projectRoot: string): string {
  const hash = createHash("sha256");
  for (const file of extractionSourceFiles(projectRoot)) {
    hash.update(file, "utf8");
    hash.update("\u0000", "utf8");
    hash.update(behaviourBearingSource(readFileSync(join(projectRoot, relative("", file)), "utf8")), "utf8");
    hash.update("\u0000", "utf8");
  }
  return hash.digest("hex").slice(0, 12);
}
