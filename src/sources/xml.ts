// A small, dependency-free XML reader.
//
// It handles the subset the parliamentary exports actually use — elements,
// attributes, text, CDATA, comments, processing instructions and the five
// predefined entities plus numeric character references. It is not a validating
// parser and makes no attempt at namespaces or DTD-defined entities: an entity it
// does not know is left in the text verbatim rather than being replaced by a guess.

import { ParseError } from "../core/errors.js";

export interface XmlNode {
  name: string;
  attributes: Record<string, string>;
  children: XmlNode[];
  /** Direct text content of this element, with entities resolved. */
  text: string;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  shy: "­",
};

/** Resolve XML entities. Unknown entities are returned untouched, on purpose. */
export function decodeEntities(text: string): string {
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
    return NAMED_ENTITIES[body] ?? whole;
  });
}

/** Parse one XML fragment into a tree. The fragment must have a single root. */
export function parseXml(source: string): XmlNode {
  const nodes = parseXmlFragment(source);
  const root = nodes[0];
  if (root === undefined) throw new ParseError("XML fragment contains no element");
  return root;
}

/** Parse a fragment that may contain several top-level elements. */
export function parseXmlFragment(source: string): XmlNode[] {
  const roots: XmlNode[] = [];
  const stack: XmlNode[] = [];
  let pos = 0;

  const push = (node: XmlNode): void => {
    const parent = stack[stack.length - 1];
    if (parent === undefined) roots.push(node);
    else parent.children.push(node);
  };

  while (pos < source.length) {
    const open = source.indexOf("<", pos);
    if (open < 0) {
      appendText(stack, source.slice(pos));
      break;
    }
    if (open > pos) appendText(stack, source.slice(pos, open));

    if (source.startsWith("<!--", open)) {
      const end = source.indexOf("-->", open + 4);
      pos = end < 0 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", open)) {
      const end = source.indexOf("]]>", open + 9);
      const body = source.slice(open + 9, end < 0 ? source.length : end);
      const parent = stack[stack.length - 1];
      if (parent !== undefined) parent.text += body;
      pos = end < 0 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith("<?", open)) {
      const end = source.indexOf("?>", open + 2);
      pos = end < 0 ? source.length : end + 2;
      continue;
    }
    if (source.startsWith("<!", open)) {
      // A DOCTYPE, possibly with an internal subset in square brackets.
      let cursor = open + 2;
      let depth = 0;
      while (cursor < source.length) {
        const ch = source[cursor];
        if (ch === "[") depth++;
        else if (ch === "]") depth--;
        else if (ch === ">" && depth <= 0) break;
        cursor++;
      }
      pos = cursor + 1;
      continue;
    }

    const close = source.indexOf(">", open);
    if (close < 0) break;
    const raw = source.slice(open + 1, close);

    if (raw.startsWith("/")) {
      const name = raw.slice(1).trim();
      // Close up to the matching element; a stray end tag is ignored rather than
      // throwing, because half a document is still worth reading.
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i]?.name === name) {
          stack.length = i;
          break;
        }
      }
      pos = close + 1;
      continue;
    }

    const selfClosing = raw.endsWith("/");
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const node = parseStartTag(body);
    push(node);
    if (!selfClosing) stack.push(node);
    pos = close + 1;
  }

  return roots;
}

function appendText(stack: XmlNode[], text: string): void {
  const parent = stack[stack.length - 1];
  if (parent !== undefined) parent.text += decodeEntities(text);
}

const ATTRIBUTE = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)')/g;

function parseStartTag(body: string): XmlNode {
  const match = /^([A-Za-z_:][-A-Za-z0-9_:.]*)/.exec(body.trim());
  const name = match?.[1] ?? "";
  const attributes: Record<string, string> = {};
  ATTRIBUTE.lastIndex = 0;
  let attribute: RegExpExecArray | null;
  while ((attribute = ATTRIBUTE.exec(body)) !== null) {
    const value = attribute[3] ?? attribute[4] ?? "";
    attributes[attribute[1] as string] = decodeEntities(value);
  }
  return { name, attributes, children: [], text: "" };
}

/** Direct child elements with the given name. */
export function childrenNamed(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((child) => child.name === name);
}

/** The first direct child with the given name. */
export function child(node: XmlNode, name: string): XmlNode | undefined {
  return node.children.find((candidate) => candidate.name === name);
}

/** Trimmed text of the first child with that name, or `undefined` when absent/blank. */
export function childText(node: XmlNode, name: string): string | undefined {
  const found = child(node, name);
  if (found === undefined) return undefined;
  const text = found.text.replace(/\s+/g, " ").trim();
  return text === "" ? undefined : text;
}

/**
 * Stream the top-level `<tag>…</tag>` fragments out of a large document.
 *
 * The Wahlperiode exports are tens of megabytes with tens of thousands of sibling
 * records; parsing the whole file into one tree would work but would hold every
 * record in memory at once for no benefit. This yields one parsed element at a
 * time. The tag must not nest inside itself, which holds for the export formats.
 */
export function* streamElements(source: string, tag: string): Generator<XmlNode> {
  const open = `<${tag}`;
  const close = `</${tag}>`;
  let pos = 0;
  for (;;) {
    const start = source.indexOf(open, pos);
    if (start < 0) return;
    const afterName = source.charAt(start + open.length);
    if (afterName !== ">" && afterName !== " " && afterName !== "\t" && afterName !== "\n" && afterName !== "\r" && afterName !== "/") {
      pos = start + open.length;
      continue;
    }
    const end = source.indexOf(close, start);
    if (end < 0) return;
    const fragment = source.slice(start, end + close.length);
    pos = end + close.length;
    const parsed = parseXmlFragment(fragment)[0];
    if (parsed !== undefined) yield parsed;
  }
}
