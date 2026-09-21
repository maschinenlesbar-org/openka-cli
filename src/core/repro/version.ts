// The extractor version stamped into every record.
//
// A record is only reproducible if you can find the code that produced it, so this
// string has to identify that code exactly. In a release build it is the git sha
// the factory froze; when that is not available it falls back to the package
// version, which at least pins a published artifact.
//
// It is read from the environment rather than baked in so the factory can stamp a
// build without a code change, and so a test can pin it to a fixed value and get
// byte-identical records across machines.

/** Environment variable the factory sets when it freezes an extractor. */
export const VERSION_ENV = "OPENKA_EXTRACTOR_VERSION";

/** Package version, updated by `npm version` like every other repo here. */
export const PACKAGE_VERSION = "0.0.1";

/**
 * The stamp for `extraction.extractor_version`. Reads the environment on every
 * call rather than caching, so a test can set it and a long-running process picks
 * up a re-stamp.
 */
export function extractorVersion(env: NodeJS.ProcessEnv = process.env): string {
  const pinned = env[VERSION_ENV]?.trim();
  if (pinned !== undefined && pinned !== "") return pinned;
  return `pkg:${PACKAGE_VERSION}`;
}
