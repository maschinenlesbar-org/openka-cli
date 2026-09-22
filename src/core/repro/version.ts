// The extractor version stamped into every record.
//
// A record is only reproducible if you can find the code that produced it, so this
// string has to identify that code exactly. In a release build it is the git sha
// the factory froze. Without one it is the package version *and* a fingerprint of
// the frozen extraction rules — the package version alone does not move when a
// segmentation rule does, which is how a corpus ended up holding records that were
// produced by different extractors under one version string.
//
// It is read from the environment rather than baked in so the factory can stamp a
// build without a code change, and so a test can pin it to a fixed value and get
// byte-identical records across machines.

import { extractionRulesFingerprint } from "../extract/fingerprint.js";

/** Environment variable the factory sets when it freezes an extractor. */
export const VERSION_ENV = "OPENKA_EXTRACTOR_VERSION";

/** Package version, updated by `npm version` like every other repo here. */
export const PACKAGE_VERSION = "0.0.1";

/**
 * The stamp for `extraction.extractor_version`. Reads the environment on every
 * call rather than caching, so a test can set it and a long-running process picks
 * up a re-stamp.
 *
 * Without a pinned version the stamp is the package version *plus a fingerprint of
 * the extraction rules*. The package version alone cannot carry the claim this
 * field makes — segmentation rules change far more often than a release, so every
 * rule family added so far shipped under the same `pkg:0.0.1`, and `ka verify`
 * ended up reporting the one thing the field exists to rule out: different bytes
 * from the same extractor version. The fingerprint moves whenever a rule, a guard
 * or a layout constant moves, with nobody having to remember.
 */
export function extractorVersion(env: NodeJS.ProcessEnv = process.env): string {
  const pinned = env[VERSION_ENV]?.trim();
  if (pinned !== undefined && pinned !== "") return pinned;
  return `pkg:${PACKAGE_VERSION}+rules:${extractionRulesFingerprint()}`;
}
