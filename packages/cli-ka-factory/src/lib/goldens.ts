// Golden fixtures: a verified input→record pair, frozen on disk.
//
// Because the line is deterministic these are real asserts, not fuzzy eval scores
// (CONCEPT.md §8). A golden holds the exact input bytes and the exact canonical
// record they produced; verifying one re-runs the extraction and compares byte for
// byte. That is what turns "the extractor changed" from something you notice in
// production into something that fails in CI.
//
// Layout:
//   fixtures/<source>/<id>/record.json      the frozen canonical record
//   fixtures/<source>/<id>/meta.json        parliament, tier and the source metadata
//   fixtures/<source>/<id>/<sha256>.bin     the input bytes, content-addressed

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { canonicalJsonLine } from "@maschinenlesbar.org/openka-lib-repro";
import { sha256 } from "@maschinenlesbar.org/openka-lib-repro";
import { extract, type FetchedDocument } from "@maschinenlesbar.org/openka-lib-extract";
import type { KaRecord, Tier } from "@maschinenlesbar.org/openka-lib-models";
import type { Store } from "@maschinenlesbar.org/openka-lib-store";
import type { Perceiver } from "@maschinenlesbar.org/openka-lib-perceive";
import { diffPaths } from "@maschinenlesbar.org/openka-lib-verify";

export interface GoldenMeta {
  id: string;
  source: string;
  tier: Tier;
  /** The extractor version that produced the frozen record. */
  extractor_version: string;
  /** Set by a human who checked the record against the PDF. */
  human_verified: boolean;
  /** Free-text note: what this fixture is here to pin down. */
  note?: string;
}

export interface Golden {
  meta: GoldenMeta;
  record: KaRecord;
  /** Absolute path of the fixture directory. */
  dir: string;
}

/**
 * The workspace root: the nearest ancestor holding both a `package.json` and a
 * `packages/` directory.
 *
 * Found by walking up rather than taken from the cwd, because `npm test` runs each
 * package's tests with that package as the cwd, and the goldens are spread across
 * all of them.
 */
export function workspaceRoot(from: string = process.cwd()): string {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "packages"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(from);
    dir = parent;
  }
}

/**
 * Every directory that can hold goldens: each package's own `fixtures/`.
 *
 * A Land's goldens live with its connector, so there is no single fixture root any
 * more. This finds them from the workspace root instead of asking the caller to
 * name seventeen directories.
 */
export function goldenRoots(workspaceRoot: string): string[] {
  const packages = join(workspaceRoot, "packages");
  if (!existsSync(packages)) return [join(workspaceRoot, "fixtures")];
  return readdirSync(packages)
    .sort()
    .map((name) => join(packages, name, "fixtures"))
    .filter((dir) => existsSync(dir));
}

/** Every golden in the workspace, ordered by package, then source, then id. */
export function listAllGoldens(root: string = workspaceRoot()): Golden[] {
  return goldenRoots(root).flatMap((dir) => listGoldens(dir));
}

/** Every golden under `root`, ordered by source then id. */
export function listGoldens(root: string): Golden[] {
  if (!existsSync(root)) return [];
  const goldens: Golden[] = [];
  for (const source of readdirSync(root).sort()) {
    const sourceDir = join(root, source);
    let ids: string[];
    try {
      ids = readdirSync(sourceDir).sort();
    } catch {
      continue;
    }
    for (const id of ids) {
      const dir = join(sourceDir, id);
      const recordPath = join(dir, "record.json");
      const metaPath = join(dir, "meta.json");
      if (!existsSync(recordPath) || !existsSync(metaPath)) continue;
      goldens.push({
        dir,
        meta: JSON.parse(readFileSync(metaPath, "utf8")) as GoldenMeta,
        record: JSON.parse(readFileSync(recordPath, "utf8")) as KaRecord,
      });
    }
  }
  return goldens;
}

/**
 * Freeze a record from a corpus as a golden. The input bytes are copied into the
 * fixture, so the fixture is self-contained and a test never touches a parliament.
 */
export function addGolden(
  store: Store,
  root: string,
  id: string,
  source: string,
  options: { note?: string } = {},
): Golden {
  const record = store.getRecord(id);
  if (record === undefined) throw new Error(`No record ${id} in the corpus`);
  const dir = join(root, source, id);
  mkdirSync(dir, { recursive: true });

  for (const document of record.source_documents) {
    if (document.sha256 === undefined) continue;
    if (!store.hasBlob(document.sha256)) {
      throw new Error(`Cannot freeze ${id}: the archived bytes for ${document.url} are missing`);
    }
    writeFileSync(join(dir, `${document.sha256}.bin`), store.getBlob(document.sha256));
  }

  const meta: GoldenMeta = {
    id,
    source,
    tier: record.extraction.model_artifacts.some((artifact) => artifact.name === "ocr") ? "ocr" : "text_layer",
    extractor_version: record.extraction.extractor_version,
    human_verified: record.extraction.review_status === "human_verified",
    ...(options.note === undefined ? {} : { note: options.note }),
  };
  writeFileSync(join(dir, "record.json"), canonicalJsonLine(record));
  writeFileSync(join(dir, "meta.json"), canonicalJsonLine(meta));
  return { meta, record, dir };
}

export interface GoldenResult {
  id: string;
  ok: boolean;
  reason?: string;
  differences: string[];
  /** True when the only change is that the extractor version moved on. */
  versionChanged: boolean;
}

/**
 * Re-extract a golden from its frozen input bytes and compare.
 *
 * The comparison ignores `extraction.extractor_version` deliberately: a version
 * bump is expected and is not, by itself, a regression. Every other byte — every
 * question, every abstention, every hash — must be identical.
 */
export async function verifyGolden(golden: Golden, perceiver?: Perceiver): Promise<GoldenResult> {
  const documents: FetchedDocument[] = [];
  for (const document of golden.record.source_documents) {
    if (document.sha256 === undefined) continue;
    const path = join(golden.dir, `${document.sha256}.bin`);
    if (!existsSync(path)) {
      return { id: golden.meta.id, ok: false, reason: `fixture is missing ${document.sha256}.bin`, differences: [], versionChanged: false };
    }
    const bytes = readFileSync(path);
    if (sha256(bytes) !== document.sha256) {
      return { id: golden.meta.id, ok: false, reason: `fixture bytes for ${document.sha256} do not hash to their name`, differences: [], versionChanged: false };
    }
    const fetched: FetchedDocument = {
      role: document.role,
      url: document.url,
      bytes,
      urlStable: document.url_stable,
    };
    if (document.retrieved_at !== undefined) fetched.retrievedAt = document.retrieved_at;
    documents.push(fetched);
  }

  if (golden.meta.tier === "ocr" && perceiver === undefined) {
    return {
      id: golden.meta.id,
      ok: false,
      reason: "this golden was produced with an OCR model; verifying it needs the same pinned model",
      differences: [],
      versionChanged: false,
    };
  }

  const { record } = await extract({
    parliament: golden.record.parliament,
    documentType: golden.record.document_type,
    tier: golden.meta.tier,
    metadata: {
      reference: golden.record.reference,
      legislative_period: golden.record.legislative_period,
      title: golden.record.title,
      askers: golden.record.askers,
      answered_by: golden.record.answered_by,
      dates: golden.record.dates,
    },
    documents,
    ...(perceiver === undefined ? {} : { perceiver }),
  });

  const expected = comparableRecord(golden.record);
  const actual = comparableRecord(record);
  const versionChanged = record.extraction.extractor_version !== golden.record.extraction.extractor_version;
  if (canonicalJsonLine(expected) === canonicalJsonLine(actual)) {
    return { id: golden.meta.id, ok: true, differences: [], versionChanged };
  }
  return {
    id: golden.meta.id,
    ok: false,
    reason: "re-extraction differs from the frozen record",
    differences: diffPaths(expected, actual),
    versionChanged,
  };
}

/** The record minus the fields allowed to move between extractor versions. */
function comparableRecord(record: KaRecord): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(record)) as KaRecord;
  copy.extraction.extractor_version = "<ignored>";
  // A human's review decision is not reproducible by definition; see `ka verify`.
  if (copy.extraction.review_status === "human_verified") copy.extraction.review_status = "needs_review";
  return copy as unknown as Record<string, unknown>;
}
