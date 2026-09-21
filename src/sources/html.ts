// Minimal, deterministic HTML helpers for the one source that has no data feed.
//
// This is not a DOM: it is a small set of scanners over markup whose class names
// are the contract. That is a fragile contract, and the design says so out loud —
// when it breaks, discovery yields zero refs, which is exactly the drift signal
// `ka-factory drift` watches for, and repairing the selectors is a factory job.

const NAMED = new Map<string, string>([
  ["amp", "&"], ["lt", "<"], ["gt", ">"], ["quot", '"'], ["apos", "'"],
  ["nbsp", " "], ["shy", ""], ["ndash", "–"], ["mdash", "—"], ["hellip", "…"],
  ["auml", "ä"], ["ouml", "ö"], ["uuml", "ü"], ["Auml", "Ä"], ["Ouml", "Ö"],
  ["Uuml", "Ü"], ["szlig", "ß"], ["euro", "€"], ["laquo", "«"], ["raquo", "»"],
  ["bdquo", "„"], ["ldquo", "“"], ["rdquo", "”"], ["sbquo", "‚"], ["lsquo", "‘"],
  ["rsquo", "’"], ["deg", "°"], ["sect", "§"], ["middot", "·"],
]);

/** Resolve HTML entities. Unknown entities are left as written. */
export function decodeHtml(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x?[0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED.get(body) ?? whole;
  });
}

/** Strip tags and collapse whitespace — the text a reader would see. */
export function textOf(html: string): string {
  return decodeHtml(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
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
  return match === null ? undefined : decodeHtml(match[1] as string);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
}
