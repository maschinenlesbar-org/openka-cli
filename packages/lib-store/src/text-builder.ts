// A text put together from many pieces, for the paths that build one from a whole
// record (the index's term normalisation, the CLI's escapers on stdout and in the log).

/** How many pieces a TextBuilder joins at a time. */
const BUILDER_BATCH = 16_384;

/**
 * A text put together from many pieces, joined in batches of BUILDER_BATCH into flat
 * strings, so memory stays proportional to the text, not to the number of pieces. One
 * `+=` per piece made a rope node each: a record of a few million characters exhausted
 * a 128 MB heap (security audit 2026-10-27).
 */
export class TextBuilder {
  readonly #done: string[] = [];
  #batch: string[] = [];

  push(...pieces: string[]): void {
    for (const piece of pieces) this.#batch.push(piece);
    if (this.#batch.length >= BUILDER_BATCH) {
      this.#done.push(this.#batch.join(""));
      this.#batch = [];
    }
  }

  toString(): string {
    this.#done.push(this.#batch.join(""));
    this.#batch = [];
    return this.#done.join("");
  }
}
