// Text helpers shared by the CLI's output paths.

import { stripBidiControls } from "@maschinenlesbar.org/openka-lib-render";
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
  return stripBidiControls(stripControlCharacters(text, { keepWhitespace: false }));
}

/** Truncate to `width` display columns, appending an ellipsis when cut — never inside a character. */
export function truncate(text: string, width: number): string {
  const clean = sanitizeForTerminal(text).replace(/\s+/g, " ").trim();
  return clean.length <= width ? clean : cutText(clean, Math.max(0, width - 1)) + "…";
}

/**
 * `text` cut to at most `max` UTF-16 units, never inside a surrogate pair: when the cut
 * would land after a high surrogate it is made one unit earlier, so a message that holds
 * the cut text is well-formed (a lone `\ud83d` makes jq reject a whole JSON stream).
 * Text no longer than `max` is returned as it is; the caller marks a cut.
 */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = max > 0 && isHighSurrogate(text.charCodeAt(max - 1)) ? max - 1 : max;
  return text.slice(0, end);
}

function isHighSurrogate(c: number): boolean {
  return c >= 0xd800 && c <= 0xdbff;
}

/**
 * `text` with every lone surrogate (half of a character) replaced by U+FFFD, like
 * `String.prototype.toWellFormed` (ES2024, so not in this package's `lib`).
 */
export function toWellFormed(text: string): string {
  return text.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "\ufffd");
}

/** Pad to `width` columns for simple column output. */
export function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

/** A byte count for people, in decimal units — the library's, so `ka` and its messages agree. */
export { formatBytes } from "@maschinenlesbar.org/openka-lib-store";

/** A count with thousands separators: "2,471". */
export function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}
