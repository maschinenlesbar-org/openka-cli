// Stream filters. Everything here is byte-exact and dependency-free: Flate comes
// from Node's built-in zlib, the rest are implemented directly from ISO 32000-1 §7.4.
//
// An unsupported filter is never approximated. `decodeStream` throws, the tier
// turns that into an abstention, and the document goes to `ka review` — which is
// the whole point: a half-decoded content stream would produce plausible nonsense.

import { inflateRawSync, inflateSync } from "node:zlib";
import { ParseError } from "@maschinenlesbar.org/openka-lib-errors";
import { isDict, isName, type PdfDict, type PdfStream, type PdfValue } from "./objects.js";

export type Resolver = (value: PdfValue | undefined) => PdfValue | undefined;

const IDENTITY: Resolver = (value) => value ?? null;

/** Filters that produce image data and are passed through to the OCR tier as-is. */
export const IMAGE_FILTERS = new Set(["DCTDecode", "JPXDecode", "JBIG2Decode", "CCITTFaxDecode"]);

/**
 * How much one document may decode across all of its streams.
 *
 * The per-stream cap (`MAX_INFLATED_BYTES`) alone leaves a document unbounded: eight
 * streams of 120 MiB each is a 1 MB PDF that costs gigabytes. Every stream a
 * document decodes is charged to its `PdfDocument`'s budget, and each filter is
 * handed only what is left of it, so a bomb stops where the budget ends rather
 * than after it has been allocated. Twice the per-stream cap: one maximal stream
 * still fits, and no real Drucksache comes near it.
 */
export const MAX_DECODED_BYTES = 512 * 1024 * 1024;

export class DecodeBudget {
  used = 0;
  constructor(readonly max: number = MAX_DECODED_BYTES) {}

  /** What the next filter may produce: the rest of the budget, never more than one stream's cap. */
  get remaining(): number {
    return Math.max(0, Math.min(MAX_INFLATED_BYTES, this.max - this.used));
  }

  charge(bytes: number): void {
    this.used += bytes;
  }
}

/**
 * Decode a stream's bytes, applying its filter chain in order.
 *
 * With a `budget`, the output is charged to it and no filter may produce more than
 * it has left; without one, each filter is bounded by `MAX_INFLATED_BYTES`.
 */
export function decodeStream(stream: PdfStream, resolve: Resolver = IDENTITY, budget?: DecodeBudget): Buffer {
  const { filters, parms } = filterChain(stream.dict, resolve);
  let data = stream.raw;
  for (let i = 0; i < filters.length; i++) {
    const filter = filters[i] as string;
    const parm = parms[i];
    const limit = budget?.remaining ?? MAX_INFLATED_BYTES;
    try {
      data = applyFilter(filter, data, parm, resolve, limit);
    } catch (err) {
      if (budget !== undefined && limit < MAX_INFLATED_BYTES && err instanceof DecodeLimitError) {
        throw new DecodeLimitError(
          `${filter} would exceed the document's decode budget (${limit} bytes left of ${budget.max}) — refusing to decode further`,
        );
      }
      throw err;
    }
  }
  budget?.charge(data.length);
  return data;
}

/** The stream's filter names and their decode parameter dictionaries, in order. */
export function filterChain(
  dict: PdfDict,
  resolve: Resolver = IDENTITY,
): { filters: string[]; parms: (PdfDict | undefined)[] } {
  const raw = resolve(dict.get("Filter") ?? dict.get("F"));
  const parmRaw = resolve(dict.get("DecodeParms") ?? dict.get("DP"));
  const filters: string[] = [];
  if (isName(raw as PdfValue)) filters.push((raw as { name: string }).name);
  else if (Array.isArray(raw)) {
    for (const item of raw) {
      const resolved = resolve(item);
      if (isName(resolved as PdfValue)) filters.push((resolved as { name: string }).name);
    }
  }
  const parms: (PdfDict | undefined)[] = [];
  if (isDict(parmRaw as PdfValue)) parms.push(parmRaw as PdfDict);
  else if (Array.isArray(parmRaw)) {
    for (const item of parmRaw) {
      const resolved = resolve(item);
      parms.push(isDict(resolved as PdfValue) ? (resolved as PdfDict) : undefined);
    }
  }
  while (parms.length < filters.length) parms.push(undefined);
  return { filters, parms };
}

function applyFilter(filter: string, data: Buffer, parm: PdfDict | undefined, resolve: Resolver, limit: number): Buffer {
  switch (filter) {
    case "FlateDecode":
    case "Fl":
      return applyPredictor(inflate(data, limit), parm, resolve);
    case "LZWDecode":
    case "LZW":
      return applyPredictor(lzwDecode(data, numberOf(resolve(parm?.get("EarlyChange")), 1), limit), parm, resolve);
    case "ASCIIHexDecode":
    case "AHx":
      return asciiHexDecode(data);
    case "ASCII85Decode":
    case "A85":
      return ascii85Decode(data, limit);
    case "RunLengthDecode":
    case "RL":
      return runLengthDecode(data, limit);
    case "Crypt":
      throw new ParseError("Encrypted stream (Crypt filter) — cannot decode");
    default:
      throw new ParseError(`Unsupported stream filter "${filter}"`);
  }
}

function numberOf(value: PdfValue | undefined, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

/**
 * The most a single stream may decode to, whichever filter expands it. The fetch
 * engine caps a *response* at 128 MiB, and without a cap here that budget buys an
 * unbounded amount of heap: a 199 KiB deflate stream of repeated bytes expands to
 * 200 MiB, so a 128 MiB body at that ratio is tens of gigabytes. LZW and RunLength
 * expand just as well — a 230 KB LZW stream cost 3.7 GB before it failed — so they
 * are held to the same cap. 256 MiB — twice the response cap since that was raised
 * to 128 MiB (issue #23) — is far beyond any real Drucksache and turns the bomb into
 * an abstention.
 */
export const MAX_INFLATED_BYTES = 256 * 1024 * 1024;

/**
 * zlib inflate, tolerating the two defects seen in the wild: a missing zlib header
 * (raw deflate) and a truncated final block. A truncated stream still yields the
 * bytes that did decode, because losing the tail of a page is better than losing
 * the page — and the caller can still tell, since the text simply stops.
 *
 * Output is bounded: see `MAX_INFLATED_BYTES`.
 */
export function inflate(data: Buffer, maxBytes: number = MAX_INFLATED_BYTES): Buffer {
  // zlib refuses a maxOutputLength below 1; an exhausted budget still decodes nothing.
  const limit = { maxOutputLength: Math.max(1, maxBytes) };
  const refuse = (out: Buffer): Buffer => {
    if (out.length > maxBytes) throw oversized("FlateDecode", maxBytes);
    return out;
  };
  try {
    return refuse(inflateSync(data, limit));
  } catch (err) {
    if (tooLarge(err)) throw oversized("FlateDecode", maxBytes);
    if (err instanceof ParseError) throw err;
  }
  try {
    return refuse(inflateRawSync(data, limit));
  } catch (err) {
    if (tooLarge(err)) throw oversized("FlateDecode", maxBytes);
    if (err instanceof ParseError) throw err;
  }
  for (const attempt of [
    () => inflateSync(data, { ...limit, finishFlush: 2 }),
    () => inflateRawSync(data, { ...limit, finishFlush: 2 }),
  ]) {
    try {
      const out = attempt();
      if (out.length > 0) return refuse(out);
    } catch (err) {
      if (tooLarge(err)) throw oversized("FlateDecode", maxBytes);
      if (err instanceof ParseError) throw err;
    }
  }
  throw new ParseError("FlateDecode failed: stream is not valid zlib or raw deflate data");
}

/** zlib signals the cap with ERR_BUFFER_TOO_LARGE; anything else is a decode failure. */
function tooLarge(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "ERR_BUFFER_TOO_LARGE"
  );
}

/** A filter's output hit its ceiling — the stream cap, or what was left of the document's budget. */
export class DecodeLimitError extends ParseError {}

function oversized(filter: string, limit: number): DecodeLimitError {
  return new DecodeLimitError(`${filter} produced more than ${limit} bytes — refusing to decode further`);
}

/**
 * A byte sink with a hard ceiling, for the filters that build their output a byte
 * at a time. A `number[]` grows until V8 gives up at its maximum array length —
 * gigabytes later — so the cap has to be checked as the bytes arrive.
 */
class BoundedOutput {
  private buf = Buffer.alloc(4096);
  length = 0;

  constructor(
    private readonly filter: string,
    private readonly limit: number,
  ) {}

  /** Make room for `n` more bytes, or refuse. Returns the write position. */
  reserve(n: number): number {
    const at = this.length;
    const needed = at + n;
    if (needed > this.limit) throw oversized(this.filter, this.limit);
    if (needed > this.buf.length) {
      const grown = Buffer.alloc(Math.min(Math.max(needed, this.buf.length * 2), Math.max(needed, this.limit)));
      this.buf.copy(grown, 0, 0, at);
      this.buf = grown;
    }
    this.length = needed;
    return at;
  }

  push(byte: number): void {
    this.buf[this.reserve(1)] = byte;
  }

  fill(byte: number, count: number): void {
    const at = this.reserve(count);
    this.buf.fill(byte, at, at + count);
  }

  /** Write position `at` directly — for a caller that reserved first. */
  set(at: number, byte: number): void {
    this.buf[at] = byte;
  }

  result(): Buffer {
    return Buffer.from(this.buf.subarray(0, this.length));
  }
}

/** PNG (10–15) and TIFF (2) predictors, as used by xref and image streams. */
export function applyPredictor(data: Buffer, parm: PdfDict | undefined, resolve: Resolver): Buffer {
  if (parm === undefined) return data;
  const predictor = numberOf(resolve(parm.get("Predictor")), 1);
  if (predictor <= 1) return data;
  const colors = numberOf(resolve(parm.get("Colors")), 1);
  const bpc = numberOf(resolve(parm.get("BitsPerComponent")), 8);
  const columns = numberOf(resolve(parm.get("Columns")), 1);
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowLength = Math.ceil((colors * bpc * columns) / 8);

  if (predictor === 2) {
    if (bpc !== 8) throw new ParseError(`TIFF predictor with ${bpc} bits per component is not supported`);
    for (let row = 0; row + rowLength <= data.length; row += rowLength) {
      for (let i = bpp; i < rowLength; i++) {
        data[row + i] = ((data[row + i] as number) + (data[row + i - bpp] as number)) & 0xff;
      }
    }
    return data;
  }

  // PNG predictors: each row is prefixed with a filter-type byte.
  const out = Buffer.alloc(Math.floor(data.length / (rowLength + 1)) * rowLength);
  let previous = Buffer.alloc(rowLength);
  let outPos = 0;
  for (let pos = 0; pos + rowLength + 1 <= data.length; pos += rowLength + 1) {
    const type = data[pos] as number;
    const row = Buffer.from(data.subarray(pos + 1, pos + 1 + rowLength));
    for (let i = 0; i < rowLength; i++) {
      const left = i >= bpp ? (row[i - bpp] as number) : 0;
      const up = previous[i] as number;
      const upLeft = i >= bpp ? (previous[i - bpp] as number) : 0;
      const value = row[i] as number;
      switch (type) {
        case 0: break;
        case 1: row[i] = (value + left) & 0xff; break;
        case 2: row[i] = (value + up) & 0xff; break;
        case 3: row[i] = (value + ((left + up) >> 1)) & 0xff; break;
        case 4: row[i] = (value + paeth(left, up, upLeft)) & 0xff; break;
        default: throw new ParseError(`Unknown PNG predictor row filter ${type}`);
      }
    }
    row.copy(out, outPos);
    outPos += rowLength;
    previous = row;
  }
  return out.subarray(0, outPos);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

export function asciiHexDecode(data: Buffer): Buffer {
  let hex = "";
  for (const byte of data) {
    const ch = String.fromCharCode(byte);
    if (ch === ">") break;
    if (/[0-9a-fA-F]/.test(ch)) hex += ch;
  }
  if (hex.length % 2 === 1) hex += "0";
  return Buffer.from(hex, "hex");
}

export function ascii85Decode(data: Buffer, maxBytes: number = MAX_INFLATED_BYTES): Buffer {
  // `z` stands for four zero bytes, so ASCII85 expands too — fourfold.
  const out = new BoundedOutput("ASCII85Decode", maxBytes);
  let tuple = 0;
  let count = 0;
  let start = 0;
  if (data.length >= 2 && data[0] === 0x3c && data[1] === 0x7e) start = 2;
  for (let i = start; i < data.length; i++) {
    const byte = data[i] as number;
    if (byte === 0x7e) break; // '~>' terminator
    if (byte === 0x7a && count === 0) {
      out.fill(0, 4);
      continue;
    }
    if (byte < 0x21 || byte > 0x75) continue; // whitespace and noise
    tuple = tuple * 85 + (byte - 0x21);
    // A five-character group encodes a 32-bit word, so anything above 2^32-1 is
    // not ASCII85. `>>> 24` would quietly take it modulo 2^32 and emit four
    // arbitrary bytes; refusing sends the document to the abstention path instead.
    if (count === 4 && tuple > 0xffffffff) {
      throw new ParseError("ASCII85Decode: a group encodes more than 32 bits");
    }
    if (++count === 5) {
      for (const shift of [24, 16, 8, 0]) out.push((tuple >>> shift) & 0xff);
      tuple = 0;
      count = 0;
    }
  }
  if (count > 0) {
    for (let i = count; i < 5; i++) tuple = tuple * 85 + 84;
    for (const shift of [24, 16, 8, 0].slice(0, count - 1)) out.push((tuple >>> shift) & 0xff);
  }
  return out.result();
}

export function runLengthDecode(data: Buffer, maxBytes: number = MAX_INFLATED_BYTES): Buffer {
  const out = new BoundedOutput("RunLengthDecode", maxBytes);
  let i = 0;
  while (i < data.length) {
    const length = data[i++] as number;
    if (length === 128) break;
    if (length < 128) {
      for (let j = 0; j <= length && i < data.length; j++) out.push(data[i++] as number);
    } else {
      // The byte to repeat has to be there. It was read unchecked, so a stream
      // truncated after a repeat-run length byte pushed `undefined` up to 128
      // times and `Buffer.from` turned every one of them into a NUL — inventing
      // content out of a truncation, in a module that refuses to approximate.
      if (i >= data.length) break;
      out.fill(data[i++] as number, 257 - length);
    }
  }
  return out.result();
}

/** LZW codes are at most 12 bits wide, so the dictionary never has more entries. */
const LZW_MAX_ENTRIES = 4096;

/**
 * LZW as PDF uses it: variable code width 9–12 bits, MSB first.
 *
 * The dictionary is a table of (prefix code, last byte) pairs rather than copied
 * byte arrays — each entry used to be a copy of the previous one plus a byte, and
 * the table kept growing past the 4096 entries a 12-bit code can address. It now
 * stops there, as the format says, and the output is bounded like every filter's.
 */
export function lzwDecode(data: Buffer, earlyChange = 1, maxBytes: number = MAX_INFLATED_BYTES): Buffer {
  const prefix = new Int32Array(LZW_MAX_ENTRIES);
  const last = new Uint8Array(LZW_MAX_ENTRIES);
  const first = new Uint8Array(LZW_MAX_ENTRIES);
  const size = new Int32Array(LZW_MAX_ENTRIES);
  for (let code = 0; code < 256; code++) {
    prefix[code] = -1;
    last[code] = code;
    first[code] = code;
    size[code] = 1;
  }
  const out = new BoundedOutput("LZWDecode", maxBytes);
  /** Write entry `code`, back to front, since the table stores it that way. */
  const write = (code: number): void => {
    const length = size[code] as number;
    const at = out.reserve(length);
    let cursor = code;
    for (let pos = at + length - 1; pos >= at; pos--) {
      out.set(pos, last[cursor] as number);
      cursor = prefix[cursor] as number;
    }
  };

  let next = 258; // 256 = clear, 257 = EOD
  let codeWidth = 9;
  let previous = -1;
  let bitBuffer = 0;
  let bitCount = 0;

  for (let i = 0; i <= data.length; i++) {
    if (i < data.length) {
      bitBuffer = ((bitBuffer << 8) | (data[i] as number)) & 0xffffff;
      bitCount += 8;
    } else if (bitCount < codeWidth) {
      break;
    }
    while (bitCount >= codeWidth) {
      const code = (bitBuffer >> (bitCount - codeWidth)) & ((1 << codeWidth) - 1);
      bitCount -= codeWidth;
      if (code === 256) {
        next = 258;
        codeWidth = 9;
        previous = -1;
        continue;
      }
      if (code === 257) return out.result();
      let firstByte: number;
      if (code < next && code !== 256 && code !== 257) {
        firstByte = first[code] as number;
      } else if (code === next && previous >= 0) {
        // The one code that may name the entry about to be made: previous + its own first byte.
        firstByte = first[previous] as number;
      } else {
        throw new ParseError(
          previous < 0
            ? "LZWDecode: code out of range before any dictionary entry"
            : `LZWDecode: code ${code} is past the dictionary (${next} entries)`,
        );
      }
      if (previous >= 0 && next < LZW_MAX_ENTRIES) {
        prefix[next] = previous;
        last[next] = firstByte;
        first[next] = first[previous] as number;
        size[next] = (size[previous] as number) + 1;
        next++;
      }
      write(code);
      previous = code;
      if (next + earlyChange >= 1 << codeWidth && codeWidth < 12) codeWidth++;
    }
  }
  return out.result();
}
