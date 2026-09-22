// A tokenizer and object parser for PDF syntax (ISO 32000-1 §7.2–7.3).
//
// It reads from a Buffer at an offset and is deliberately forgiving about
// whitespace and malformed trailing bytes, because the documents this project has
// to read were produced by a long tail of Word add-ins and print drivers. It is not
// forgiving about *meaning*: anything it cannot interpret becomes a parse failure
// the caller turns into an abstention, never a guess.

import { ParseError } from "@maschinenlesbar.org/openka-lib-errors";
import { isDict, name as makeName, type PdfDict, type PdfStream, type PdfValue } from "./objects.js";

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMITERS = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

export function isWhitespace(byte: number): boolean {
  return WHITESPACE.has(byte);
}

export function isDelimiter(byte: number): boolean {
  return DELIMITERS.has(byte);
}

/** A bare keyword such as `obj`, `endobj`, `stream`, `R`, `BT`, `Tj`. */
export interface PdfKeyword {
  readonly kind: "keyword";
  readonly value: string;
}

export type LexValue = PdfValue | PdfKeyword;

export function isKeyword(value: LexValue | undefined, expected?: string): value is PdfKeyword {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    (value as { kind: string }).kind === "keyword" &&
    (expected === undefined || (value as PdfKeyword).value === expected)
  );
}

/**
 * How deeply arrays and dictionaries may nest before the document is refused.
 *
 * Real PDFs nest a handful of levels; a document that nests hundreds is either
 * corrupt or hostile. Without a bound the recursive readers overflow the stack and
 * throw a RangeError, which is not a `ParseError` — and this module's contract is
 * that anything it cannot interpret becomes a parse failure the caller turns into
 * an abstention.
 */
export const MAX_NESTING_DEPTH = 256;

export class Lexer {
  pos: number;
  private depth = 0;

  constructor(
    readonly buf: Buffer,
    start = 0,
  ) {
    this.pos = start;
  }

  atEnd(): boolean {
    return this.pos >= this.buf.length;
  }

  /** Skip whitespace and `%` comments. */
  skipSpace(): void {
    while (this.pos < this.buf.length) {
      const byte = this.buf[this.pos] as number;
      if (WHITESPACE.has(byte)) {
        this.pos++;
        continue;
      }
      if (byte === 0x25) {
        while (this.pos < this.buf.length) {
          const c = this.buf[this.pos] as number;
          if (c === 0x0a || c === 0x0d) break;
          this.pos++;
        }
        continue;
      }
      return;
    }
  }

  /**
   * Read the next token. Returns `undefined` at end of input. Indirect references
   * (`12 0 R`) are recognised here by lookahead, since `12` and `0` are otherwise
   * indistinguishable from two plain numbers.
   */
  next(): LexValue | undefined {
    this.skipSpace();
    if (this.atEnd()) return undefined;
    const byte = this.buf[this.pos] as number;

    if (byte === 0x2f) return this.readName();
    if (byte === 0x28) return this.readLiteralString();
    if (byte === 0x5b) {
      this.pos++;
      return this.readArray();
    }
    if (byte === 0x5d) {
      this.pos++;
      return { kind: "keyword", value: "]" };
    }
    if (byte === 0x3c) {
      if (this.buf[this.pos + 1] === 0x3c) {
        this.pos += 2;
        return this.readDict();
      }
      return this.readHexString();
    }
    if (byte === 0x3e && this.buf[this.pos + 1] === 0x3e) {
      this.pos += 2;
      return { kind: "keyword", value: ">>" };
    }
    if (byte === 0x7b || byte === 0x7d) {
      this.pos++;
      return { kind: "keyword", value: String.fromCharCode(byte) };
    }
    if ((byte >= 0x30 && byte <= 0x39) || byte === 0x2b || byte === 0x2d || byte === 0x2e) {
      return this.readNumberOrRef();
    }
    return this.readKeyword();
  }

  private readKeyword(): LexValue {
    const start = this.pos;
    while (this.pos < this.buf.length) {
      const byte = this.buf[this.pos] as number;
      if (WHITESPACE.has(byte) || DELIMITERS.has(byte)) break;
      this.pos++;
    }
    if (this.pos === start) {
      // An isolated delimiter we do not understand; consume it so we make progress.
      this.pos++;
      return { kind: "keyword", value: String.fromCharCode(this.buf[start] as number) };
    }
    const word = this.buf.toString("latin1", start, this.pos);
    if (word === "true") return true;
    if (word === "false") return false;
    if (word === "null") return null;
    return { kind: "keyword", value: word };
  }

  private readName(): PdfValue {
    this.pos++; // '/'
    let out = "";
    while (this.pos < this.buf.length) {
      const byte = this.buf[this.pos] as number;
      if (WHITESPACE.has(byte) || DELIMITERS.has(byte)) break;
      if (byte === 0x23 && this.pos + 2 < this.buf.length) {
        const hex = this.buf.toString("latin1", this.pos + 1, this.pos + 3);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          this.pos += 3;
          continue;
        }
      }
      out += String.fromCharCode(byte);
      this.pos++;
    }
    return makeName(out);
  }

  private readNumberOrRef(): PdfValue {
    const first = this.readNumber();
    if (!Number.isInteger(first) || first < 0) return first;
    const save = this.pos;
    this.skipSpace();
    if (this.pos < this.buf.length) {
      const byte = this.buf[this.pos] as number;
      if (byte >= 0x30 && byte <= 0x39) {
        const second = this.readNumber();
        this.skipSpace();
        if (Number.isInteger(second) && second >= 0 && this.buf[this.pos] === 0x52) {
          const after = this.buf[this.pos + 1];
          if (after === undefined || WHITESPACE.has(after) || DELIMITERS.has(after)) {
            this.pos++;
            return { kind: "ref", num: first, gen: second };
          }
        }
      }
    }
    this.pos = save;
    return first;
  }

  private readNumber(): number {
    const start = this.pos;
    if (this.buf[this.pos] === 0x2b || this.buf[this.pos] === 0x2d) this.pos++;
    while (this.pos < this.buf.length) {
      const byte = this.buf[this.pos] as number;
      if ((byte >= 0x30 && byte <= 0x39) || byte === 0x2e || byte === 0x2d || byte === 0x2b) {
        this.pos++;
        continue;
      }
      break;
    }
    const text = this.buf.toString("latin1", start, this.pos);
    const value = Number.parseFloat(text);
    return Number.isFinite(value) ? value : 0;
  }

  private readLiteralString(): PdfValue {
    this.pos++; // '('
    const out: number[] = [];
    let depth = 1;
    while (this.pos < this.buf.length) {
      const byte = this.buf[this.pos++] as number;
      if (byte === 0x5c) {
        const esc = this.buf[this.pos++];
        if (esc === undefined) break;
        switch (esc) {
          case 0x6e: out.push(0x0a); break;
          case 0x72: out.push(0x0d); break;
          case 0x74: out.push(0x09); break;
          case 0x62: out.push(0x08); break;
          case 0x66: out.push(0x0c); break;
          case 0x0a: break; // line continuation
          case 0x0d:
            if (this.buf[this.pos] === 0x0a) this.pos++;
            break;
          default:
            if (esc >= 0x30 && esc <= 0x37) {
              let octal = esc - 0x30;
              for (let i = 0; i < 2; i++) {
                const digit = this.buf[this.pos];
                if (digit === undefined || digit < 0x30 || digit > 0x37) break;
                octal = octal * 8 + (digit - 0x30);
                this.pos++;
              }
              out.push(octal & 0xff);
            } else {
              out.push(esc);
            }
        }
        continue;
      }
      if (byte === 0x28) depth++;
      if (byte === 0x29) {
        depth--;
        if (depth === 0) break;
      }
      out.push(byte);
    }
    return { kind: "string", bytes: Buffer.from(out) };
  }

  private readHexString(): PdfValue {
    this.pos++; // '<'
    let hex = "";
    while (this.pos < this.buf.length) {
      const byte = this.buf[this.pos++] as number;
      if (byte === 0x3e) break;
      const ch = String.fromCharCode(byte);
      if (/[0-9a-fA-F]/.test(ch)) hex += ch;
    }
    if (hex.length % 2 === 1) hex += "0";
    return { kind: "string", bytes: Buffer.from(hex, "hex") };
  }

  private enter(what: string): void {
    if (++this.depth > MAX_NESTING_DEPTH) {
      this.depth = 0;
      throw new ParseError(`${what} nested deeper than ${MAX_NESTING_DEPTH} levels`);
    }
  }

  private readArray(): PdfValue {
    this.enter("Array");
    try {
      return this.readArrayBody();
    } finally {
      this.depth--;
    }
  }

  private readArrayBody(): PdfValue {
    const items: PdfValue[] = [];
    for (;;) {
      this.skipSpace();
      if (this.atEnd()) break;
      if (this.buf[this.pos] === 0x5d) {
        this.pos++;
        break;
      }
      const token = this.next();
      if (token === undefined) break;
      if (isKeyword(token)) {
        if (token.value === "]") break;
        continue; // a stray keyword inside an array carries no value
      }
      items.push(token);
    }
    return items;
  }

  private readDict(): PdfValue {
    this.enter("Dictionary");
    try {
      return this.readDictBody();
    } finally {
      this.depth--;
    }
  }

  private readDictBody(): PdfValue {
    const dict: PdfDict = new Map();
    for (;;) {
      this.skipSpace();
      if (this.atEnd()) break;
      if (this.buf[this.pos] === 0x3e && this.buf[this.pos + 1] === 0x3e) {
        this.pos += 2;
        break;
      }
      const key = this.next();
      if (key === undefined) break;
      if (isKeyword(key)) {
        if (key.value === ">>") break;
        continue;
      }
      if (typeof key !== "object" || key === null || !("kind" in key) || key.kind !== "name") continue;
      const value = this.next();
      if (value === undefined) break;
      if (isKeyword(value)) {
        if (value.value === ">>") break;
        continue;
      }
      dict.set(key.name, value as PdfValue);
    }
    return dict;
  }

  /**
   * Parse one indirect object body starting after `N G obj`. Returns the value, or
   * a stream when the dictionary is followed by the `stream` keyword.
   */
  readIndirectBody(resolveLength: (value: PdfValue) => PdfValue): PdfValue {
    const value = this.next();
    if (value === undefined) throw new ParseError("Unexpected end of object");
    if (isKeyword(value)) throw new ParseError(`Unexpected keyword "${value.value}" in object body`);
    if (!isDict(value)) return value;

    const save = this.pos;
    const token = this.next();
    if (!isKeyword(token, "stream")) {
      this.pos = save;
      return value;
    }
    // After `stream` comes CRLF or LF (never CR alone, per the spec — but some
    // producers emit CR alone, so accept it).
    if (this.buf[this.pos] === 0x0d) this.pos++;
    if (this.buf[this.pos] === 0x0a) this.pos++;
    const start = this.pos;

    const declared = resolveLength(value.get("Length") ?? null);
    let end: number;
    if (typeof declared === "number" && declared >= 0 && start + declared <= this.buf.length) {
      end = start + declared;
      // Trust /Length only when `endstream` really follows it; a wrong length is a
      // common defect and silently truncating a content stream would lose text.
      const tail = this.buf.toString("latin1", end, Math.min(end + 20, this.buf.length));
      if (!/^[\r\n \t\0]*endstream/.test(tail)) end = findEndstream(this.buf, start);
    } else {
      end = findEndstream(this.buf, start);
    }
    this.pos = end;
    const raw = this.buf.subarray(start, end);
    const stream: PdfStream = { kind: "stream", dict: value, raw };
    // Step past `endstream` so a caller scanning forward is not confused by it.
    const after = this.buf.indexOf("endstream", end, "latin1");
    if (after >= 0) this.pos = after + "endstream".length;
    return stream;
  }
}

/** Locate the `endstream` that closes a stream starting at `start`. */
function findEndstream(buf: Buffer, start: number): number {
  const at = buf.indexOf("endstream", start, "latin1");
  if (at < 0) return buf.length;
  let end = at;
  // Drop the EOL that precedes `endstream`; it is a delimiter, not stream data.
  if (end > start && buf[end - 1] === 0x0a) end--;
  if (end > start && buf[end - 1] === 0x0d) end--;
  return end;
}
