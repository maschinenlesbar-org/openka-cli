// Minimal, deterministic HTML helpers for the one source that has no data feed.
//
// This is not a DOM: it is a small set of scanners over markup whose class names
// are the contract. That is a fragile contract, and the design says so out loud —
// when it breaks, discovery yields zero refs, which is exactly the drift signal
// `ka-factory drift` watches for, and repairing the selectors is a factory job.

import { stripControlCharacters } from "../core/text.js";

const NAMED = new Map<string, string>([
  ["amp", "&"], ["lt", "<"], ["gt", ">"], ["quot", '"'], ["apos", "'"],
  ["nbsp", " "], ["shy", ""], ["ndash", "–"], ["mdash", "—"], ["hellip", "…"],
  ["auml", "ä"], ["ouml", "ö"], ["uuml", "ü"], ["Auml", "Ä"], ["Ouml", "Ö"],
  ["Uuml", "Ü"], ["szlig", "ß"], ["euro", "€"], ["laquo", "«"], ["raquo", "»"],
  ["bdquo", "„"], ["ldquo", "“"], ["rdquo", "”"], ["sbquo", "‚"], ["lsquo", "‘"],
  ["rsquo", "’"], ["deg", "°"], ["sect", "§"], ["middot", "·"],
]);

/**
 * True for a code point a character reference may legally denote. The surrogate
 * range is excluded: `String.fromCodePoint(0xd800)` yields a lone surrogate, which
 * is not a character, cannot be written to XML, and turns into U+FFFD the moment
 * the string is encoded as UTF-8 — so a feed built from it stops matching the
 * record it came from.
 */
function isUsableCodePoint(code: number): boolean {
  return Number.isFinite(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
}

/** Resolve HTML entities. Unknown entities are left as written. */
export function decodeHtml(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x?[0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return isUsableCodePoint(code) ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return isUsableCodePoint(code) ? String.fromCodePoint(code) : whole;
    }
    return NAMED.get(body) ?? whole;
  });
}

/** Strip tags and collapse whitespace — the text a reader would see. */
export function textOf(html: string): string {
  return stripControlCharacters(decodeHtml(html.replace(/<[^>]*>/g, " "))).replace(/\s+/g, " ").trim();
}

/**
 * Remove the regions a browser does not show (`class="d-none"`), then read the text.
 *
 * This is the difference between reading a result row and misreading it. The
 * Parlamentsspiegel hides a "Neuestes Dokument: <date>" span inside every row; that
 * date belongs to the newest document of the Vorgang — usually the *answer* — while
 * the visible date is the question's. Taking the text of the whole row therefore
 * dates a Kleine Anfrage by its answer, and any date window built on it excludes
 * exactly the records it was meant to include.
 */
export function visibleTextOf(html: string): string {
  return textOf(stripHidden(html));
}

/**
 * Drop `d-none` elements, including their contents, without a DOM.
 *
 * Nesting has to be counted rather than matched with a lazy regex: the hidden block
 * in a result row contains further spans, and stopping at the first `</span>` would
 * leave the part that matters — the date — behind, which is exactly the defect this
 * function exists to prevent.
 */
export function stripHidden(html: string): string {
  const opener = /<(span|div|p)\b[^>]*\sclass="(?:[^"]*\s)?d-none(?:\s[^"]*)?"[^>]*>/i;
  let out = html;
  // Each pass replaces an element with a single space, so the string strictly
  // shrinks and the loop cannot run away; the bound is a sanity rail, not a
  // policy. It used to be 100, which silently stopped stripping on a fragment
  // with more hidden elements than that and returned half-stripped markup — the
  // exact defect this function exists to prevent, with no signal that it happened.
  for (let guard = 0; guard <= html.length; guard++) {
    const match = opener.exec(out);
    if (match === null) break;
    const tag = (match[1] as string).toLowerCase();
    const end = endOfElement(out, match.index + match[0].length, tag);
    out = out.slice(0, match.index) + " " + out.slice(end);
  }
  return out;
}

/**
 * Index just past the `</tag>` that closes an element whose content starts at
 * `from`, counting nested openings of the same tag. Returns the end of the string
 * when the document does not close it.
 */
function endOfElement(html: string, from: number, tag: string): number {
  const scanner = new RegExp(`<(/?)${tag}\\b[^>]*?(/?)>`, "gi");
  scanner.lastIndex = from;
  let depth = 1;
  let match: RegExpExecArray | null;
  while ((match = scanner.exec(html)) !== null) {
    if (match[2] === "/") continue; // self-closing
    depth += match[1] === "/" ? -1 : 1;
    if (depth === 0) return match.index + match[0].length;
  }
  return html.length;
}

/**
 * Slice out the top-level regions that begin with an opening tag carrying `cls`
 * and end at `terminator` (or the next region of the same class). Class matching
 * is on a whole word, so `ps-folge` does not match `ps-folge-dok`.
 */
export function blocksWithClass(html: string, cls: string, terminator?: RegExp): string[] {
  const opener = new RegExp(`<div[^>]*\\sclass="(?:[^"]*\\s)?${escapeRegExp(cls)}(?:\\s[^"]*)?"[^>]*>`, "g");
  const starts: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = opener.exec(html)) !== null) starts.push(match.index);
  return starts.map((start, i) => {
    const nextStart = starts[i + 1] ?? html.length;
    const slice = html.slice(start, nextStart);
    if (terminator === undefined) return slice;
    const end = terminator.exec(slice);
    return end === null ? slice : slice.slice(0, end.index);
  });
}

/** The inner HTML of the first `<p class="…cls…">…</p>`-ish region. */
export function regionWithClass(html: string, cls: string): string | undefined {
  const opener = new RegExp(`<(p|div|span)[^>]*\\sclass="(?:[^"]*\\s)?${escapeRegExp(cls)}(?:\\s[^"]*)?"[^>]*>`);
  const match = opener.exec(html);
  if (match === null) return undefined;
  const from = match.index + match[0].length;
  const closer = new RegExp(`</${match[1]}>`, "g");
  closer.lastIndex = from;
  const end = closer.exec(html);
  return html.slice(from, end?.index ?? html.length);
}

/** Every `<span>…</span>` text inside a fragment, in document order. */
export function spanTexts(html: string): string[] {
  const out: string[] = [];
  const pattern = /<span\b[^>]*>([\s\S]*?)<\/span>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    const text = textOf(match[1] as string);
    if (text !== "") out.push(text);
  }
  return out;
}

/** The `href` of the first anchor in a fragment. */
export function firstHref(html: string): string | undefined {
  const match = /<a\b[^>]*\bhref="([^"]+)"/.exec(html);
  // A URL becomes `source_documents[].url` and is printed back to a terminal, so
  // it is held to the same hygiene as the text around it.
  return match === null ? undefined : stripControlCharacters(decodeHtml(match[1] as string));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
}
