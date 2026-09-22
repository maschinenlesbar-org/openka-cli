// Hashing helpers. Every fact in the corpus traces back to one of these digests:
// `input_sha256` (the exact bytes parsed), a blob's content address, and the
// record digest `ka verify` compares.

import { createHash } from "node:crypto";
import { canonicalJsonLine } from "./canonical.js";

/** Lowercase hex sha256 of raw bytes. */
export function sha256(data: Buffer | Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Lowercase hex sha256 of a value's canonical JSON form (including the newline). */
export function sha256Canonical(value: unknown): string {
  return sha256(Buffer.from(canonicalJsonLine(value), "utf8"));
}

/** True for a well-formed lowercase hex sha256 digest. */
export function isSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}
