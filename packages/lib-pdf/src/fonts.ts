// Font metrics: what a character code means, and how wide it is.
//
// The widths matter as much as the mapping. Without them a text extractor has to
// guess where one word ends and the next begins, and the guess is wrong exactly
// where documents are hardest — a hyphenated place name split across two text runs
// becomes "Treptow - Köpenick" or "TreptowKöpenick" depending on which way the
// guess falls. With the widths from the font dictionary the gap between two runs is
// a measured number, and a space is inserted when there is really a space.

import { decodeStream } from "./filters.js";
import { baseEncoding, glyphToUnicode, parseToUnicode, type ToUnicodeMap } from "./encoding.js";
import type { PdfDocument } from "./document.js";
import { isDict, isName, isStream, type PdfDict } from "./objects.js";

/** Glyph space is 1/1000 of text space for every font type PDF supports. */
export const GLYPH_SPACE = 1000;

export interface Font {
  /** Bytes per character code: 1 for simple fonts, 2 for Identity-H composites. */
  codeBytes: number;
  /** Unicode for a code, or `undefined` when nothing maps it. */
  decode(code: number): string | undefined;
  /** Advance width in glyph space (1/1000 em). */
  width(code: number): number;
  /** True when this font has no usable mapping at all. */
  unmappable: boolean;
}

/** A font that maps nothing — recorded so the tier can abstain with a reason. */
const UNMAPPABLE: Font = {
  codeBytes: 1,
  decode: () => undefined,
  width: () => 500,
  unmappable: true,
};

export class FontCache {
  private readonly cache = new Map<PdfDict, Font>();
  /** Resource names whose font could not be mapped. */
  readonly unmappable = new Set<string>();

  constructor(private readonly doc: PdfDocument) {}

  get(dict: PdfDict, label: string): Font {
    const cached = this.cache.get(dict);
    if (cached !== undefined) {
      if (cached.unmappable) this.unmappable.add(label);
      return cached;
    }
    const font = this.build(dict);
    this.cache.set(dict, font);
    if (font.unmappable) this.unmappable.add(label);
    return font;
  }

  private build(dict: PdfDict): Font {
    const toUnicode = this.loadToUnicode(dict);
    return isName(this.doc.get(dict, "Subtype"), "Type0")
      ? this.buildComposite(dict, toUnicode)
      : this.buildSimple(dict, toUnicode);
  }

  private buildComposite(dict: PdfDict, toUnicode: ToUnicodeMap | undefined): Font {
    const doc = this.doc;
    const encoding = doc.get(dict, "Encoding");
    const identity = isName(encoding) && /^Identity-[HV]$/.test(encoding.name);
    if (toUnicode === undefined && !identity) return UNMAPPABLE;

    const descendants = doc.resolve(dict.get("DescendantFonts"));
    const descendant = Array.isArray(descendants) ? doc.dict(descendants[0]) : undefined;
    const defaultWidth = (descendant === undefined ? undefined : doc.num(descendant.get("DW"))) ?? 1000;
    const widths = descendant === undefined ? new Map<number, number>() : this.parseW(descendant);
    const map = toUnicode?.map;

    return {
      codeBytes: 2,
      decode: (code) => map?.get(code),
      width: (code) => widths.get(code) ?? defaultWidth,
      unmappable: map === undefined,
    };
  }

  /**
   * The /W array of a CIDFont, in its two forms:
   *   `c [w1 w2 …]`  widths for consecutive CIDs starting at c
   *   `c1 c2 w`      one width for every CID from c1 to c2
   */
  private parseW(descendant: PdfDict): Map<number, number> {
    const widths = new Map<number, number>();
    const array = this.doc.resolve(descendant.get("W"));
    if (!Array.isArray(array)) return widths;
    for (let i = 0; i < array.length; ) {
      const first = this.doc.num(array[i]);
      const second = this.doc.resolve(array[i + 1]);
      if (first === undefined) break;
      if (Array.isArray(second)) {
        second.forEach((value, offset) => {
          const width = this.doc.num(value);
          if (width !== undefined) widths.set(first + offset, width);
        });
        i += 2;
        continue;
      }
      const last = this.doc.num(array[i + 1]);
      const width = this.doc.num(array[i + 2]);
      if (last === undefined || width === undefined) break;
      // A range of tens of thousands of CIDs is legal but is never worth
      // materialising; cap it so a hostile or broken file cannot exhaust memory.
      const upper = Math.min(last, first + 65_535);
      for (let cid = first; cid <= upper; cid++) widths.set(cid, width);
      i += 3;
    }
    return widths;
  }

  private buildSimple(dict: PdfDict, toUnicode: ToUnicodeMap | undefined): Font {
    const doc = this.doc;
    const table = this.simpleEncodingTable(dict);
    if (toUnicode === undefined && table === undefined) return UNMAPPABLE;

    const firstChar = doc.num(dict.get("FirstChar")) ?? 0;
    const widthArray = doc.resolve(dict.get("Widths"));
    const widths: number[] = [];
    if (Array.isArray(widthArray)) {
      for (const value of widthArray) widths.push(doc.num(value) ?? 0);
    }
    const descriptor = doc.dict(dict.get("FontDescriptor"));
    // ISO 32000-1 makes MissingWidth default to 0. We deliberately use 500 instead:
    // a width of 0 for every code a broken font left out of /Widths stacks those
    // glyphs at one x, and `assemble` then reads the whole run as a single word.
    // Half an em is wrong too, but wrong in a way that keeps the words apart.
    const missingWidth = (descriptor === undefined ? undefined : doc.num(descriptor.get("MissingWidth"))) ?? 500;

    return {
      codeBytes: 1,
      decode: (code) => {
        const mapped = toUnicode?.map.get(code);
        if (mapped !== undefined && mapped !== "") return mapped;
        const unicode = table?.[code];
        return unicode === undefined ? undefined : String.fromCodePoint(unicode);
      },
      width: (code) => {
        // Only a code outside /Widths is missing. A declared width of 0 is a real
        // width — combining marks and the soft hyphen have one — and treating it as
        // absent handed those glyphs half an em of advance, which is exactly the
        // amount that invents a word break where the font said there is none.
        const index = code - firstChar;
        const width = index >= 0 && index < widths.length ? (widths[index] as number) : undefined;
        return width ?? missingWidth;
      },
      unmappable: false,
    };
  }

  private loadToUnicode(dict: PdfDict): ToUnicodeMap | undefined {
    const stream = this.doc.resolve(dict.get("ToUnicode"));
    if (!isStream(stream)) return undefined;
    try {
      return parseToUnicode(decodeStream(stream, (value) => this.doc.resolve(value)));
    } catch {
      return undefined;
    }
  }

  /** Byte -> code point for a simple font: base encoding plus /Differences. */
  private simpleEncodingTable(dict: PdfDict): (number | undefined)[] | undefined {
    const encoding = this.doc.get(dict, "Encoding");
    if (isName(encoding)) {
      const named = baseEncoding(encoding.name);
      return named === undefined ? undefined : [...named];
    }
    if (!isDict(encoding)) {
      // A symbolic font with no /Encoding uses the encoding built into its font
      // program, which this reader does not parse. Only /ToUnicode can rescue such
      // a font; without one the caller abstains rather than printing noise.
      if (isName(this.doc.get(dict, "Subtype"), "Type3")) return undefined;
      return [...(baseEncoding(undefined) as (number | undefined)[])];
    }
    const base = this.doc.get(encoding, "BaseEncoding");
    // An unmodelled base still leaves /Differences usable: those entries name their
    // glyphs, so they resolve. Everything the list does not name stays unmapped
    // rather than being read through the wrong table.
    const modelled = baseEncoding(isName(base) ? base.name : undefined);
    const table: (number | undefined)[] = modelled === undefined ? new Array(256).fill(undefined) : [...modelled];
    const differences = this.doc.get(encoding, "Differences");
    if (Array.isArray(differences)) {
      let code = 0;
      for (const item of differences) {
        const value = this.doc.resolve(item);
        if (typeof value === "number") code = Math.trunc(value);
        else if (isName(value)) {
          if (code >= 0 && code < 256) table[code] = glyphToUnicode(value.name);
          code++;
        }
      }
    }
    return table;
  }
}
