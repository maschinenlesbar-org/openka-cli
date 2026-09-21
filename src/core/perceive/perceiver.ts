// The only place a trained model may run on the line (CONCEPT.md §6).
//
// A Perceiver is a narrow, perceptual component: image in, characters out. It is
// bound by four rules, and the seam exists to make them checkable:
//
//   * deterministic inference — fixed weights, greedy decode, no sampling;
//   * version-locked and hashed — what ran lands in `extraction.model_artifacts`;
//   * validated against goldens before it may be used;
//   * it abstains rather than emitting a guess.
//
// The default implementation abstains on everything. That is "strict mode" from the
// concept: no neural component on the line at all, at the cost of coverage on scans.

import type { ModelArtifact } from "../models/schema.js";

export interface PerceiveInput {
  /** Encoded image bytes, exactly as they were embedded in the PDF. */
  data: Buffer;
  /** `jpeg`, `jpeg2000`, `jbig2`, `ccitt` — what the bytes are. */
  format: string;
  page: number;
}

export interface PerceiveOutput {
  text: string;
  /**
   * True when the perceiver declined. `text` is then empty and `reason` says why;
   * the tier records an abstention for the page rather than an empty page.
   */
  abstained: boolean;
  reason?: string;
}

export interface Perceiver {
  /** Stable name, e.g. `ocr`. */
  readonly name: string;
  /** The artifact record written into every record this perceiver touched. */
  artifact(): ModelArtifact;
  /** True when the perceiver can run at all here (binary present, module installed). */
  available(): boolean;
  recognize(input: PerceiveInput): Promise<PerceiveOutput>;
}

/**
 * Strict mode: no model runs. Every page of a scanned document abstains, and the
 * document lands in `ka review` with an explicit reason.
 */
export const abstainingPerceiver: Perceiver = {
  name: "none",
  artifact: () => ({ name: "none", version: "strict-mode" }),
  available: () => true,
  recognize: async (input) => ({
    abstained: true,
    text: "",
    reason: `strict mode: no OCR model is enabled, page ${input.page} not read`,
  }),
};
