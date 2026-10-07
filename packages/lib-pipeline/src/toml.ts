// The part of TOML a plan file needs, and nothing more: the line has no runtime
// dependency beyond commander, and a plan file is a handful of tables.
//
// Read: comments, `[table]` and `[[array of tables]]` headers with bare names,
// `key = value` with bare keys, and as values basic ("…") and literal ('…') strings
// on one line, decimal integers (underscores between digits allowed), booleans, a
// local date (`2025-01-01`, read as its text) and arrays of these, which may span
// lines. Everything else TOML has — floats, times, inline tables, dotted keys,
// multi-line strings — is refused by name rather than misread.

import { UsageError } from "@maschinenlesbar.org/openka-lib-errors";

export type TomlValue = string | number | boolean | TomlValue[];
export type TomlTable = Record<string, TomlValue>;
/** A document: values at the top, tables, and arrays of tables. */
export type TomlDocument = Record<string, TomlValue | TomlTable | TomlTable[]>;

const BARE = /[A-Za-z0-9_-]/;

class Scanner {
  pos = 0;
  line = 1;
  constructor(
    readonly text: string,
    readonly where: string,
  ) {}

  fail(message: string): never {
    throw new UsageError(`${this.where}:${this.line}: ${message}`);
  }

  peek(offset = 0): string {
    return this.text[this.pos + offset] ?? "";
  }

  next(): string {
    const ch = this.text[this.pos++] ?? "";
    if (ch === "\n") this.line++;
    return ch;
  }

  eof(): boolean {
    return this.pos >= this.text.length;
  }

  /** Spaces and tabs only. */
  skipBlanks(): void {
    while (this.peek() === " " || this.peek() === "\t") this.pos++;
  }

  skipComment(): void {
    if (this.peek() !== "#") return;
    while (!this.eof() && this.peek() !== "\n") this.pos++;
  }

  /** Blanks, comments and line breaks: between statements and inside arrays. */
  skipSpace(): void {
    for (;;) {
      this.skipBlanks();
      this.skipComment();
      if (this.peek() === "\n" || (this.peek() === "\r" && this.peek(1) === "\n")) {
        if (this.peek() === "\r") this.pos++;
        this.next();
        continue;
      }
      return;
    }
  }

  /** After a statement: only blanks and a comment before the line ends. */
  endOfLine(): void {
    this.skipBlanks();
    this.skipComment();
    if (this.eof()) return;
    if (this.peek() === "\r" && this.peek(1) === "\n") this.pos++;
    if (this.peek() !== "\n") this.fail(`unexpected "${this.peek()}" after the value; one statement per line`);
  }

  bareName(what: string): string {
    const start = this.pos;
    while (BARE.test(this.peek())) this.pos++;
    const name = this.text.slice(start, this.pos);
    if (name === "") {
      const ch = this.peek();
      this.fail(ch === '"' || ch === "'" ? `quoted ${what}s are not supported in a plan file` : `expected a ${what}`);
    }
    if (this.peek() === ".") this.fail(`dotted ${what}s are not supported in a plan file`);
    return name;
  }
}

/** Parse `text`; `where` names it in messages ("jobs.toml"). Throws `UsageError` with the line. */
export function parseToml(text: string, where = "plan"): TomlDocument {
  const s = new Scanner(text, where);
  const root: TomlDocument = {};
  const tables = new Set<string>();
  let current: Record<string, unknown> = root;
  for (;;) {
    s.skipSpace();
    if (s.eof()) return root;
    if (s.peek() === "[") {
      s.next();
      const array = s.peek() === "[";
      if (array) s.next();
      s.skipBlanks();
      const name = s.bareName("table name");
      s.skipBlanks();
      if (s.next() !== "]" || (array && s.next() !== "]")) s.fail(`expected "${array ? "]]" : "]"}" after [${array ? "[" : ""}${name}`);
      const existing = root[name];
      if (array) {
        if (existing !== undefined && !Array.isArray(existing)) s.fail(`[[${name}]] after ${name} was defined as something else`);
        const list = (existing as TomlTable[] | undefined) ?? [];
        const table: TomlTable = {};
        list.push(table);
        root[name] = list;
        current = table;
      } else {
        if (existing !== undefined || tables.has(name)) s.fail(`[${name}] is defined twice`);
        const table: TomlTable = {};
        tables.add(name);
        root[name] = table;
        current = table;
      }
      s.endOfLine();
      continue;
    }
    const key = s.bareName("key");
    s.skipBlanks();
    if (s.next() !== "=") s.fail(`expected "=" after ${key}`);
    s.skipBlanks();
    const value = readValue(s);
    if (Object.hasOwn(current, key)) s.fail(`${key} is set twice`);
    current[key] = value;
    s.endOfLine();
  }
}

function readValue(s: Scanner): TomlValue {
  const ch = s.peek();
  if (ch === '"') {
    if (s.peek(1) === '"' && s.peek(2) === '"') s.fail("multi-line strings are not supported in a plan file");
    return basicString(s);
  }
  if (ch === "'") {
    if (s.peek(1) === "'" && s.peek(2) === "'") s.fail("multi-line strings are not supported in a plan file");
    s.next();
    const start = s.pos;
    while (!s.eof() && s.peek() !== "'" && s.peek() !== "\n") s.pos++;
    if (s.peek() !== "'") s.fail("unterminated string");
    const value = s.text.slice(start, s.pos);
    s.next();
    return value;
  }
  if (ch === "[") {
    s.next();
    const items: TomlValue[] = [];
    for (;;) {
      s.skipSpace();
      if (s.peek() === "]") {
        s.next();
        return items;
      }
      items.push(readValue(s));
      s.skipSpace();
      const sep = s.next();
      if (sep === "]") return items;
      if (sep !== ",") s.fail(`expected "," or "]" in an array`);
    }
  }
  if (ch === "{") s.fail("inline tables are not supported in a plan file");
  const start = s.pos;
  while (/[A-Za-z0-9_+\-:.]/.test(s.peek())) s.pos++;
  const token = s.text.slice(start, s.pos);
  if (token === "true") return true;
  if (token === "false") return false;
  if (/^\d{4}-\d{2}-\d{2}$/.test(token)) return token;
  if (/^[+-]?\d+(_\d+)*$/.test(token)) {
    const n = Number(token.replace(/_/g, ""));
    if (!Number.isSafeInteger(n)) s.fail(`${token} is too large`);
    return n;
  }
  if (token === "") s.fail("expected a value");
  s.fail(`${token} is not a value a plan file reads (a string, an integer, true/false, a date or an array)`);
}

function basicString(s: Scanner): string {
  s.next();
  let value = "";
  for (;;) {
    const ch = s.next();
    if (ch === "" || ch === "\n") s.fail("unterminated string");
    if (ch === '"') return value;
    if (ch !== "\\") {
      value += ch;
      continue;
    }
    const escape = s.next();
    const simple: Record<string, string> = { '"': '"', "\\": "\\", n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" };
    if (simple[escape] !== undefined) {
      value += simple[escape];
    } else if (escape === "u" || escape === "U") {
      const digits = s.text.slice(s.pos, s.pos + (escape === "u" ? 4 : 8));
      if (!/^[0-9A-Fa-f]+$/.test(digits) || digits.length !== (escape === "u" ? 4 : 8)) s.fail(`bad \\${escape} escape`);
      const code = parseInt(digits, 16);
      if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) s.fail(`\\${escape}${digits} is not a character`);
      value += String.fromCodePoint(code);
      s.pos += digits.length;
    } else {
      s.fail(`unknown escape \\${escape}`);
    }
  }
}
