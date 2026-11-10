// Minimal, deterministic HTML helpers for the one source that has no data feed.
//
// This is not a DOM: it is a small set of scanners over markup whose class names
// are the contract. That is a fragile contract, and the design says so out loud —
// when it breaks, discovery yields zero refs, which is exactly the drift signal
// `ka-factory drift` watches for, and repairing the selectors is a factory job.
//
// Every scan is linear in the markup. Inside a tag, a pattern takes anything but `<`,
// `>` and a quote, or a whole quoted value, which may hold both (`TAG_BODY`) — the
// Parlamentsspiegel's tooltips carry `title="<b>Keine</b> …"`. An unanchored `[^>]*`
// ran from every tag start to the end of a body that never closes its tags, so 140 KB
// of `<div a ` blocked the event loop for ~4 s and a few MB for tens of minutes
// (security audit 2026-10-27); a scan now stops at the first unquoted `<`.

import { stripControlCharacters } from "@maschinenlesbar.org/openka-lib-text";

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
  return stripControlCharacters(decodeHtml(stripTags(html))).replace(/\s+/g, " ").trim();
}

/**
 * Every `<…>` replaced by a space — what `/<[^>]*>/g` does, in one pass: a tag runs
 * from a `<` to the first `>` after it, and once no `>` follows, no later `<` can
 * close either, so the rest is kept as written instead of rescanned from each `<`.
 */
function stripTags(html: string): string {
  let out = "";
  let kept = 0;
  for (;;) {
    const open = html.indexOf("<", kept);
    if (open === -1) break;
    const close = html.indexOf(">", open + 1);
    if (close === -1) break;
    out += html.slice(kept, open) + " ";
    kept = close + 1;
  }
  return out + html.slice(kept);
}

/**
 * The opening tag `<name …>` as a global, case-insensitive pattern (`name` is a regex
 * source): inside it anything but `<`, `>` and a quote, or a whole quoted value
 * (`TAG_BODY`), so a scan stops at the first unquoted `<`.
 */
export function openingTagPattern(name: string): RegExp {
  return new RegExp(`<${name}\\b${TAG_BODY}>`, "gi");
}

/**
 * The content of each `<tag …>…</tag>` in document order, as a lazy
 * `<tag\b[^>]*>([\s\S]*?)</tag\s*>` reads it: from an opening tag `accept` takes (given
 * the whole tag) to the first `</tag>` after it, the search going on after that closer.
 * Linear: the opening tag stops at an unquoted `<`, and once one element has no closer,
 * no later one has, so the scan ends there rather than searching again from every
 * opener to the end (security audit 2026-10-27).
 */
export function* elementContents(html: string, tag: string, accept: (openingTag: string) => boolean = () => true): Generator<string> {
  const opener = openingTagPattern(tag);
  const closer = new RegExp(`</${tag}\\s*>`, "gi");
  let match: RegExpExecArray | null;
  while ((match = opener.exec(html)) !== null) {
    if (!accept(match[0])) continue;
    const from = match.index + match[0].length;
    closer.lastIndex = from;
    const end = closer.exec(html);
    if (end === null) return;
    yield html.slice(from, end.index);
    opener.lastIndex = closer.lastIndex;
  }
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
  const opener = classTagPattern("(span|div|p)\\b", "d-none", "gi");
  // One forward pass: each hidden element, contents and all, becomes a single space,
  // and the scan goes on after it. It used to rescan from the start after every
  // element (with a guard of 100 that once stopped half-way and leaked the hidden
  // date); every element is stripped, however many there are.
  let out = "";
  let kept = 0;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(html)) !== null) {
    const tag = (match[1] as string).toLowerCase();
    const end = endOfElement(html, match.index + match[0].length, tag);
    out += html.slice(kept, match.index) + " ";
    kept = end;
    opener.lastIndex = end;
  }
  return out + html.slice(kept);
}

/**
 * Index just past the `</tag>` that closes an element whose content starts at
 * `from`, counting nested openings of the same tag. Returns the end of the string
 * when the document does not close it.
 */
function endOfElement(html: string, from: number, tag: string): number {
  const scanner = new RegExp(`<(/?)${tag}\\b${TAG_BODY_LAZY}(/?)>`, "gi");
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
  const opener = classTagPattern("div", cls, "g");
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
  const opener = classTagPattern("(p|div|span)", cls);
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
  const opener = new RegExp(`<span\\b${TAG_BODY}>`, "g");
  let match: RegExpExecArray | null;
  while ((match = opener.exec(html)) !== null) {
    const from = match.index + match[0].length;
    // The first `</span>` closes it (no nesting is counted, as before). With none
    // left, no later span closes either: stop rather than search again from each.
    const close = html.indexOf("</span>", from);
    if (close === -1) break;
    const text = textOf(html.slice(from, close));
    if (text !== "") out.push(text);
    opener.lastIndex = close + "</span>".length;
  }
  return out;
}

/** The `href` of the first anchor in a fragment. */
export function firstHref(html: string): string | undefined {
  const match = FIRST_HREF.exec(html);
  // A URL becomes `source_documents[].url` and is printed back to a terminal, so
  // it is held to the same hygiene as the text around it.
  return match === null ? undefined : stripControlCharacters(decodeHtml(match[1] as string));
}

/**
 * The inside of a tag: anything but `<`, `>` and a quote, or a whole quoted value,
 * which may hold both. Stopping at an unquoted `<` keeps a scan linear: one that met
 * no `>` used to run on to the end of the body from every tag start.
 */
const TAG_BODY = `(?:[^<>"']|"[^"]*"|'[^']*')*`;
const TAG_BODY_LAZY = `(?:[^<>"']|"[^"]*"|'[^']*')*?`;

const FIRST_HREF = new RegExp(`<a\\b${TAG_BODY}\\bhref="([^"]+)"`);

/**
 * An opening tag (`tags` is a pattern for its name, `(p|div)` say) whose class
 * attribute names `cls` as a whole word, so `ps-folge` does not match `ps-folge-dok`.
 */
export function classTagPattern(tags: string, cls: string, flags = ""): RegExp {
  return new RegExp(`<${tags}${TAG_BODY}\\sclass="(?:[^"]*\\s)?${escapeRegExp(cls)}(?:\\s[^"]*)?"${TAG_BODY}>`, flags);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
}
