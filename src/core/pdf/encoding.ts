// Turning font byte codes into Unicode.
//
// Three mechanisms, tried in this order for every font:
//   1. a /ToUnicode CMap, which the producer wrote precisely so text can be
//      extracted — authoritative when present;
//   2. a base encoding (/WinAnsiEncoding, /MacRomanEncoding, /StandardEncoding)
//      plus any /Differences, resolved through glyph names;
//   3. nothing — the code is unmappable, and the font is reported as such so the
//      tier can abstain instead of emitting replacement characters.

import { Lexer, isKeyword } from "./lexer.js";
import { isString, type PdfValue } from "./objects.js";

/** WinAnsiEncoding is CP1252: ASCII, a special 0x80–0x9F block, then Latin-1. */
const CP1252_HIGH = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039,
  0x0152, 0x008d, 0x017d, 0x008f, 0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
];

const MAC_ROMAN_HIGH = [
  0x00c4, 0x00c5, 0x00c7, 0x00c9, 0x00d1, 0x00d6, 0x00dc, 0x00e1, 0x00e0, 0x00e2, 0x00e4, 0x00e3,
  0x00e5, 0x00e7, 0x00e9, 0x00e8, 0x00ea, 0x00eb, 0x00ed, 0x00ec, 0x00ee, 0x00ef, 0x00f1, 0x00f3,
  0x00f2, 0x00f4, 0x00f6, 0x00f5, 0x00fa, 0x00f9, 0x00fb, 0x00fc, 0x2020, 0x00b0, 0x00a2, 0x00a3,
  0x00a7, 0x2022, 0x00b6, 0x00df, 0x00ae, 0x00a9, 0x2122, 0x00b4, 0x00a8, 0x2260, 0x00c6, 0x00d8,
  0x221e, 0x00b1, 0x2264, 0x2265, 0x00a5, 0x00b5, 0x2202, 0x2211, 0x220f, 0x03c0, 0x222b, 0x00aa,
  0x00ba, 0x03a9, 0x00e6, 0x00f8, 0x00bf, 0x00a1, 0x00ac, 0x221a, 0x0192, 0x2248, 0x2206, 0x00ab,
  0x00bb, 0x2026, 0x00a0, 0x00c0, 0x00c3, 0x00d5, 0x0152, 0x0153, 0x2013, 0x2014, 0x201c, 0x201d,
  0x2018, 0x2019, 0x00f7, 0x25ca, 0x00ff, 0x0178, 0x2044, 0x20ac, 0x2039, 0x203a, 0xfb01, 0xfb02,
  0x2021, 0x00b7, 0x201a, 0x201e, 0x2030, 0x00c2, 0x00ca, 0x00c1, 0x00cb, 0x00c8, 0x00cd, 0x00ce,
  0x00cf, 0x00cc, 0x00d3, 0x00d4, 0xf8ff, 0x00d2, 0x00da, 0x00db, 0x00d9, 0x0131, 0x02c6, 0x02dc,
  0x00af, 0x02d8, 0x02d9, 0x02da, 0x00b8, 0x02dd, 0x02db, 0x02c7,
];

/** StandardEncoding differs from ASCII in the quote and punctuation region. */
const STANDARD_OVERRIDES: Record<number, number> = {
  0x27: 0x2019, 0x60: 0x2018, 0xa1: 0x00a1, 0xa4: 0x2044, 0xa5: 0x00a5, 0xa6: 0x0192,
  0xa7: 0x00a7, 0xa8: 0x00a4, 0xa9: 0x0027, 0xaa: 0x201c, 0xab: 0x00ab, 0xac: 0x2039,
  0xad: 0x203a, 0xae: 0xfb01, 0xaf: 0xfb02, 0xb1: 0x2013, 0xb2: 0x2020, 0xb3: 0x2021,
  0xb4: 0x00b7, 0xb6: 0x00b6, 0xb7: 0x2022, 0xb8: 0x201a, 0xb9: 0x201e, 0xba: 0x201d,
  0xbb: 0x00bb, 0xbc: 0x2026, 0xbd: 0x2030, 0xbf: 0x00bf, 0xc1: 0x0060, 0xc2: 0x00b4,
  0xc3: 0x02c6, 0xc4: 0x02dc, 0xc5: 0x00af, 0xc6: 0x02d8, 0xc7: 0x02d9, 0xc8: 0x00a8,
  0xca: 0x02da, 0xcb: 0x00b8, 0xcd: 0x02dd, 0xce: 0x02db, 0xcf: 0x02c7, 0xd0: 0x2014,
  0xe1: 0x00c6, 0xe3: 0x00aa, 0xe8: 0x0141, 0xe9: 0x00d8, 0xea: 0x0152, 0xeb: 0x00ba,
  0xf1: 0x00e6, 0xf5: 0x0131, 0xf8: 0x0142, 0xf9: 0x00f8, 0xfa: 0x0153, 0xfb: 0x00df,
};

function buildTable(high: number[], lowLatin1: boolean): (number | undefined)[] {
  const table: (number | undefined)[] = new Array(256).fill(undefined);
  for (let i = 0x20; i < 0x7f; i++) table[i] = i;
  for (let i = 0; i < high.length; i++) table[0x80 + i] = high[i];
  if (lowLatin1) for (let i = 0xa0; i <= 0xff; i++) if (table[i] === undefined) table[i] = i;
  return table;
}

export const WIN_ANSI = buildTable(CP1252_HIGH, true);
export const MAC_ROMAN = buildTable(MAC_ROMAN_HIGH, false);
export const STANDARD = (() => {
  const table = buildTable([], false);
  for (const [code, unicode] of Object.entries(STANDARD_OVERRIDES)) table[Number(code)] = unicode;
  return table;
})();

/**
 * Base encodings addressable by name in a font dictionary, or `undefined` for one
 * this reader does not model.
 *
 * `MacExpertEncoding` is the only such name, and it used to return WinAnsi as "the
 * least-wrong fallback". It is not least-wrong, it is wrong: the expert set is
 * small caps, oldstyle figures and fractions at the same code points WinAnsi uses
 * for ordinary letters, so reading one as the other produces confident nonsense —
 * the thing this module's header says it refuses to do. Unmodelled means unmapped,
 * and a `/ToUnicode` CMap or a `/Differences` list can still rescue the font.
 */
export function baseEncoding(encodingName: string | undefined): (number | undefined)[] | undefined {
  switch (encodingName) {
    case "MacRomanEncoding":
      return MAC_ROMAN;
    case "StandardEncoding":
      return STANDARD;
    case "MacExpertEncoding":
      return undefined;
    case "WinAnsiEncoding":
    default:
      return WIN_ANSI;
  }
}

/**
 * Adobe Glyph List, the subset that occurs in German administrative documents:
 * Latin letters with the accents German, French and Turkish names bring, plus the
 * punctuation typesetters actually use. Names outside the list resolve through the
 * algorithmic `uniXXXX` / `uXXXX` forms, and anything left over stays unmapped.
 */
const GLYPH_NAMES: Record<string, number> = {
  space: 0x20, exclam: 0x21, quotedbl: 0x22, numbersign: 0x23, dollar: 0x24, percent: 0x25,
  ampersand: 0x26, quotesingle: 0x27, parenleft: 0x28, parenright: 0x29, asterisk: 0x2a,
  plus: 0x2b, comma: 0x2c, hyphen: 0x2d, period: 0x2e, slash: 0x2f, zero: 0x30, one: 0x31,
  two: 0x32, three: 0x33, four: 0x34, five: 0x35, six: 0x36, seven: 0x37, eight: 0x38,
  nine: 0x39, colon: 0x3a, semicolon: 0x3b, less: 0x3c, equal: 0x3d, greater: 0x3e,
  question: 0x3f, at: 0x40, bracketleft: 0x5b, backslash: 0x5c, bracketright: 0x5d,
  asciicircum: 0x5e, underscore: 0x5f, grave: 0x60, braceleft: 0x7b, bar: 0x7c,
  braceright: 0x7d, asciitilde: 0x7e, exclamdown: 0xa1, cent: 0xa2, sterling: 0xa3,
  currency: 0xa4, yen: 0xa5, brokenbar: 0xa6, section: 0xa7, dieresis: 0xa8, copyright: 0xa9,
  ordfeminine: 0xaa, guillemotleft: 0xab, logicalnot: 0xac, registered: 0xae, macron: 0xaf,
  degree: 0xb0, plusminus: 0xb1, acute: 0xb4, mu: 0xb5, paragraph: 0xb6, periodcentered: 0xb7,
  cedilla: 0xb8, ordmasculine: 0xba, guillemotright: 0xbb, onequarter: 0xbc, onehalf: 0xbd,
  threequarters: 0xbe, questiondown: 0xbf, Agrave: 0xc0, Aacute: 0xc1, Acircumflex: 0xc2,
  Atilde: 0xc3, Adieresis: 0xc4, Aring: 0xc5, AE: 0xc6, Ccedilla: 0xc7, Egrave: 0xc8,
  Eacute: 0xc9, Ecircumflex: 0xca, Edieresis: 0xcb, Igrave: 0xcc, Iacute: 0xcd,
  Icircumflex: 0xce, Idieresis: 0xcf, Eth: 0xd0, Ntilde: 0xd1, Ograve: 0xd2, Oacute: 0xd3,
  Ocircumflex: 0xd4, Otilde: 0xd5, Odieresis: 0xd6, multiply: 0xd7, Oslash: 0xd8,
  Ugrave: 0xd9, Uacute: 0xda, Ucircumflex: 0xdb, Udieresis: 0xdc, Yacute: 0xdd, Thorn: 0xde,
  germandbls: 0xdf, agrave: 0xe0, aacute: 0xe1, acircumflex: 0xe2, atilde: 0xe3,
  adieresis: 0xe4, aring: 0xe5, ae: 0xe6, ccedilla: 0xe7, egrave: 0xe8, eacute: 0xe9,
  ecircumflex: 0xea, edieresis: 0xeb, igrave: 0xec, iacute: 0xed, icircumflex: 0xee,
  idieresis: 0xef, eth: 0xf0, ntilde: 0xf1, ograve: 0xf2, oacute: 0xf3, ocircumflex: 0xf4,
  otilde: 0xf5, odieresis: 0xf6, divide: 0xf7, oslash: 0xf8, ugrave: 0xf9, uacute: 0xfa,
  ucircumflex: 0xfb, udieresis: 0xfc, yacute: 0xfd, thorn: 0xfe, ydieresis: 0xff,
  Euro: 0x20ac, quoteleft: 0x2018, quoteright: 0x2019, quotedblleft: 0x201c,
  quotedblright: 0x201d, quotesinglbase: 0x201a, quotedblbase: 0x201e, endash: 0x2013,
  emdash: 0x2014, bullet: 0x2022, ellipsis: 0x2026, dagger: 0x2020, daggerdbl: 0x2021,
  perthousand: 0x2030, guilsinglleft: 0x2039, guilsinglright: 0x203a, fraction: 0x2044,
  fi: 0xfb01, fl: 0xfb02, OE: 0x0152, oe: 0x0153, Scaron: 0x0160, scaron: 0x0161,
  Zcaron: 0x017d, zcaron: 0x017e, Ydieresis: 0x0178, florin: 0x0192, circumflex: 0x02c6,
  tilde: 0x02dc, minus: 0x2212, trademark: 0x2122, nbspace: 0x00a0,
};

/** Resolve a PostScript glyph name to a code point, or `undefined` if unknown. */
export function glyphToUnicode(glyph: string): number | undefined {
  const known = GLYPH_NAMES[glyph];
  if (known !== undefined) return known;
  if (/^[A-Za-z]$/.test(glyph)) return glyph.charCodeAt(0);
  let match = /^uni([0-9A-Fa-f]{4})/.exec(glyph);
  if (match) return parseInt(match[1] as string, 16);
  match = /^u([0-9A-Fa-f]{4,6})$/.exec(glyph);
  if (match) return parseInt(match[1] as string, 16);
  // `Xxx.sc`, `a.alt` and friends: the part before the first dot carries the glyph.
  const dot = glyph.indexOf(".");
  if (dot > 0) return glyphToUnicode(glyph.slice(0, dot));
  return undefined;
}

/** A parsed /ToUnicode CMap: code -> string, with the code byte-length it uses. */
export interface ToUnicodeMap {
  /** Byte length of a character code, 1 or 2. */
  codeBytes: number;
  map: Map<number, string>;
}

function bufferToString(bytes: Buffer): string {
  // CMap destinations are UTF-16BE, possibly several code units for one code.
  let out = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode(bytes.readUInt16BE(i));
  if (bytes.length === 1) out += String.fromCharCode(bytes[0] as number);
  return out;
}

function bufferToCode(bytes: Buffer): number {
  let code = 0;
  for (const byte of bytes) code = (code << 8) | byte;
  return code;
}

/**
 * Parse a /ToUnicode CMap stream. Only the constructs PDF producers emit for text
 * extraction are handled — codespace ranges, bfchar and bfrange. Anything else is
 * skipped rather than approximated.
 */
export function parseToUnicode(data: Buffer): ToUnicodeMap {
  const map = new Map<number, string>();
  let codeBytes = 1;
  const lexer = new Lexer(data, 0);
  const pending: PdfValue[] = [];

  for (;;) {
    const token = lexer.next();
    if (token === undefined) break;
    if (!isKeyword(token)) {
      pending.push(token as PdfValue);
      if (pending.length > 600) pending.splice(0, pending.length - 600);
      continue;
    }
    switch (token.value) {
      case "begincodespacerange": {
        const first = lexer.next();
        if (isString(first as PdfValue)) codeBytes = Math.max(1, Math.min(2, (first as { bytes: Buffer }).bytes.length));
        pending.length = 0;
        break;
      }
      case "beginbfchar": {
        for (;;) {
          const src = lexer.next();
          if (src === undefined || isKeyword(src)) break;
          const dst = lexer.next();
          if (dst === undefined || isKeyword(dst)) break;
          if (isString(src as PdfValue) && isString(dst as PdfValue)) {
            map.set(bufferToCode((src as { bytes: Buffer }).bytes), bufferToString((dst as { bytes: Buffer }).bytes));
          }
        }
        pending.length = 0;
        break;
      }
      case "beginbfrange": {
        for (;;) {
          const lo = lexer.next();
          if (lo === undefined || isKeyword(lo)) break;
          const hi = lexer.next();
          if (hi === undefined || isKeyword(hi)) break;
          const dst = lexer.next();
          if (dst === undefined || isKeyword(dst)) break;
          if (!isString(lo as PdfValue) || !isString(hi as PdfValue)) continue;
          const start = bufferToCode((lo as { bytes: Buffer }).bytes);
          const end = bufferToCode((hi as { bytes: Buffer }).bytes);
          if (end < start || end - start > 65_535) continue;
          if (isString(dst as PdfValue)) {
            const base = (dst as { bytes: Buffer }).bytes;
            for (let code = start; code <= end; code++) {
              const shifted = Buffer.from(base);
              if (shifted.length >= 2) shifted.writeUInt16BE((shifted.readUInt16BE(shifted.length - 2) + (code - start)) & 0xffff, shifted.length - 2);
              map.set(code, bufferToString(shifted));
            }
          } else if (Array.isArray(dst)) {
            dst.forEach((item, i) => {
              if (isString(item)) map.set(start + i, bufferToString(item.bytes));
            });
          }
        }
        pending.length = 0;
        break;
      }
      default:
        pending.length = 0;
    }
  }
  return { codeBytes, map };
}
