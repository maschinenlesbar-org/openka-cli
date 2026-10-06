// Text helpers shared by the CLI's output paths.

import { stripControlCharacters } from "@maschinenlesbar.org/openka-lib-text";

/**
 * Escape the control characters JSON.stringify leaves raw. It escapes C0 but not
 * DEL or the C1 range U+0080–U+009F, and terminals act on those — U+009B is the
 * 8-bit form of CSI. Record text is upstream data, so escape them; the result is
 * equivalent, valid JSON, since these only occur inside strings.
 */
export function escapeControlChars(json: string): string {
  let result = "";
  let from = 0;
  for (let i = 0; i < json.length; i++) {
    const code = json.charCodeAt(i);
    if (code >= 0x7f && code <= 0x9f) {
      result += json.slice(from, i) + "\\u" + code.toString(16).padStart(4, "0");
      from = i + 1;
    }
  }
  return from === 0 ? json : result + json.slice(from);
}

/**
 * Strip the characters a terminal would act on from text that came from a
 * parliament's website or PDF. Every human-readable line the CLI prints goes
 * through this: a Drucksache title is upstream data like any other.
 *
 * A terminal line is one line, so the structural whitespace goes too.
 */
export function sanitizeForTerminal(text: string): string {
  return stripControlCharacters(text, { keepWhitespace: false }).replace(BIDI_CONTROLS, "");
}

/**
 * The bidirectional-text controls: embeddings and overrides (U+202A–U+202E),
 * isolates (U+2066–U+2069) and the implicit marks (U+200E, U+200F, U+061C). A
 * terminal obeys them, so a title carrying U+202E printed the rest of its line —
 * and, once `truncate` had cut off the closing U+202C, the score after it —
 * reversed. Record text keeps them; only what reaches a terminal loses them.
 */
const BIDI_CONTROLS = /[\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/g;

/** Truncate to `width` display columns, appending an ellipsis when cut. */
export function truncate(text: string, width: number): string {
  const clean = sanitizeForTerminal(text).replace(/\s+/g, " ").trim();
  return clean.length <= width ? clean : clean.slice(0, Math.max(0, width - 1)) + "…";
}

/** Pad to `width` columns for simple column output. */
export function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}
