// Text helpers shared by the CLI's output paths.

import { stripControlCharacters } from "../core/text.js";

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
  return stripControlCharacters(text, { keepWhitespace: false });
}

/** Truncate to `width` display columns, appending an ellipsis when cut. */
export function truncate(text: string, width: number): string {
  const clean = sanitizeForTerminal(text).replace(/\s+/g, " ").trim();
  return clean.length <= width ? clean : clean.slice(0, Math.max(0, width - 1)) + "…";
}

/** Pad to `width` columns for simple column output. */
export function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}
