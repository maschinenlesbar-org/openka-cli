// Stream filters. Everything here is byte-exact and dependency-free: Flate comes
// from Node's built-in zlib, the rest are implemented directly from ISO 32000-1 §7.4.
//
// An unsupported filter is never approximated. `decodeStream` throws, the tier
// turns that into an abstention, and the document goes to `ka review` — which is
// the whole point: a half-decoded content stream would produce plausible nonsense.

import { inflateRawSync, inflateSync } from "node:zlib";
import { ParseError } from "../errors.js";
import { isDict, isName, type PdfDict, type PdfStream, type PdfValue } from "./objects.js";

export type Resolver = (value: PdfValue | undefined) => PdfValue | undefined;

const IDENTITY: Resolver = (value) => value ?? null;

/** Filters that produce image data and are passed through to the OCR tier as-is. */
export const IMAGE_FILTERS = new Set(["DCTDecode", "JPXDecode", "JBIG2Decode", "CCITTFaxDecode"]);

/** Decode a stream's bytes, applying its filter chain in order. */
export function decodeStream(stream: PdfStream, resolve: Resolver = IDENTITY): Buffer {
  const { filters, parms } = filterChain(stream.dict, resolve);
  let data = stream.raw;
  for (let i = 0; i < filters.length; i++) {
    const filter = filters[i] as string;
    const parm = parms[i];
    data = applyFilter(filter, data, parm, resolve);
  }
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

function applyFilter(filter: string, data: Buffer, parm: PdfDict | undefined, resolve: Resolver): Buffer {
  switch (filter) {
    case "FlateDecode":
    case "Fl":
      return applyPredictor(inflate(data), parm, resolve);
    case "LZWDecode":
    case "LZW":
      return applyPredictor(lzwDecode(data, numberOf(resolve(parm?.get("EarlyChange")), 1)), parm, resolve);
    case "ASCIIHexDecode":
    case "AHx":
      return asciiHexDecode(data);
    case "ASCII85Decode":
    case "A85":
      return ascii85Decode(data);
    case "RunLengthDecode":
    case "RL":
      return runLengthDecode(data);
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
 * The most a single stream may inflate to. The fetch engine caps a *response* at
 * 64 MiB, and without a cap here that budget buys an unbounded amount of heap: a
 * 199 KiB deflate stream of repeated bytes expands to 200 MiB, so a 64 MiB body at
 * that ratio is tens of gigabytes. 128 MiB is far beyond any real Drucksache and
 * turns the bomb into an abstention.
 */
export const MAX_INFLATED_BYTES = 128 * 1024 * 1024;

/**
 * zlib inflate, tolerating the two defects seen in the wild: a missing zlib header
 * (raw deflate) and a truncated final block. A truncated stream still yields the
 * bytes that did decode, because losing the tail of a page is better than losing
 * the page — and the caller can still tell, since the text simply stops.
 *
 * Output is bounded: see `MAX_INFLATED_BYTES`.
 */
export function inflate(data: Buffer): Buffer {
  const limit = { maxOutputLength: MAX_INFLATED_BYTES };
  try {
    return inflateSync(data, limit);
  } catch (err) {
    if (tooLarge(err)) throw oversized();
  }
  try {
    return inflateRawSync(data, limit);
  } catch (err) {
    if (tooLarge(err)) throw oversized();
  }
  for (const attempt of [
    () => inflateSync(data, { ...limit, finishFlush: 2 }),
    () => inflateRawSync(data, { ...limit, finishFlush: 2 }),
  ]) {
    try {
      const out = attempt();
      if (out.length > 0) return out;
    } catch (err) {
      if (tooLarge(err)) throw oversized();
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

function oversized(): ParseError {
  return new ParseError(
    `FlateDecode produced more than ${MAX_INFLATED_BYTES} bytes — refusing to inflate further`,
  );
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

export function ascii85Decode(data: Buffer): Buffer {
  const out: number[] = [];
  let tuple = 0;
  let count = 0;
  let start = 0;
  if (data.length >= 2 && data[0] === 0x3c && data[1] === 0x7e) start = 2;
  for (let i = start; i < data.length; i++) {
    const byte = data[i] as number;
    if (byte === 0x7e) break; // '~>' terminator
    if (byte === 0x7a && count === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    if (byte < 0x21 || byte > 0x75) continue; // whitespace and noise
    tuple = tuple * 85 + (byte - 0x21);
    if (++count === 5) {
      out.push((tuple >>> 24) & 0xff, (tuple >>> 16) & 0xff, (tuple >>> 8) & 0xff, tuple & 0xff);
      tuple = 0;
      count = 0;
    }
  }
  if (count > 0) {
    for (let i = count; i < 5; i++) tuple = tuple * 85 + 84;
    const bytes = [(tuple >>> 24) & 0xff, (tuple >>> 16) & 0xff, (tuple >>> 8) & 0xff, tuple & 0xff];
    out.push(...bytes.slice(0, count - 1));
  }
  return Buffer.from(out);
}

export function runLengthDecode(data: Buffer): Buffer {
  const out: number[] = [];
  let i = 0;
  while (i < data.length) {
    const length = data[i++] as number;
    if (length === 128) break;
    if (length < 128) {
      for (let j = 0; j <= length && i < data.length; j++) out.push(data[i++] as number);
    } else {
      const byte = data[i++] as number;
      for (let j = 0; j < 257 - length; j++) out.push(byte);
    }
  }
  return Buffer.from(out);
}

/** LZW as PDF uses it: variable code width 9–12 bits, MSB first. */
export function lzwDecode(data: Buffer, earlyChange = 1): Buffer {
  const out: number[] = [];
  let dictionary: number[][] = [];
  const reset = (): void => {
    dictionary = [];
    for (let i = 0; i < 256; i++) dictionary.push([i]);
    dictionary.push([], []); // 256 = clear, 257 = EOD
  };
  reset();

  let codeWidth = 9;
  let previous: number[] | undefined;
  let bitBuffer = 0;
  let bitCount = 0;

  for (let i = 0; i <= data.length; i++) {
    if (i < data.length) {
      bitBuffer = (bitBuffer << 8) | (data[i] as number);
      bitCount += 8;
    } else if (bitCount < codeWidth) {
      break;
    }
    while (bitCount >= codeWidth) {
      const code = (bitBuffer >> (bitCount - codeWidth)) & ((1 << codeWidth) - 1);
      bitCount -= codeWidth;
      if (code === 256) {
        reset();
        codeWidth = 9;
        previous = undefined;
        continue;
      }
      if (code === 257) return Buffer.from(out);
      let entry: number[];
      if (code < dictionary.length) {
        entry = dictionary[code] as number[];
      } else if (previous !== undefined) {
        entry = [...previous, previous[0] as number];
      } else {
        throw new ParseError("LZWDecode: code out of range before any dictionary entry");
      }
      out.push(...entry);
      if (previous !== undefined) dictionary.push([...previous, entry[0] as number]);
      previous = entry;
      const limit = dictionary.length + earlyChange;
      if (limit >= 1 << codeWidth && codeWidth < 12) codeWidth++;
    }
  }
  return Buffer.from(out);
}
