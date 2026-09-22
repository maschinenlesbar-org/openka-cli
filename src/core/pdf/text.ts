// The content-stream interpreter: PDF drawing operators in, plain text out.
//
// A PDF has no lines and no words. It has glyphs at coordinates, and getting text
// back out means reconstructing the reading order from geometry. That reconstruction
// is done here in two stages:
//
//   1. **Interpret.** Run the operators, tracking the text and transformation
//      matrices, and record every run of glyphs with its position, its size and its
//      measured advance width.
//   2. **Assemble.** Group the runs into lines by their baseline, order each line by
//      x, and insert a space wherever the measured gap between two runs is wider
//      than a fraction of an em.
//
// Doing it this way rather than streaming text as the operators arrive is not
// over-engineering — it is the difference between reading these documents and not.
// Berlin's PDFs are produced by a tool that emits one `BT … ET` block per text run,
// so a reader that treats `ET` as a line ending turns every document into confetti.
//
// The two thresholds below are *frozen rules* in the sense of CONCEPT.md §5:
// changing one changes the bytes of every record produced through this tier, and so
// is an extractor-version bump.

import { decodeStream } from "./filters.js";
import { stripControlCharacters } from "../text.js";
import { Lexer, isKeyword, type LexValue } from "./lexer.js";
import { FontCache, GLYPH_SPACE, type Font } from "./fonts.js";
import type { PdfDocument } from "./document.js";
import { isName, isStream, isString, type PdfDict, type PdfValue } from "./objects.js";

/** Two runs on one line are separated by a space when the gap exceeds this fraction of an em. */
export const WORD_GAP_EM = 0.18;

/** Baselines closer together than this fraction of the font size are the same line. */
export const LINE_TOLERANCE_EM = 0.4;

/** How deeply a Form XObject may nest before we stop following it. */
const MAX_XOBJECT_DEPTH = 8;

/**
 * Typographic spaces, folded to a plain space, and invisible characters, dropped.
 *
 * This is not cosmetic. The Bundestag right-aligns question numbers with an EN
 * SPACE (U+2002), so a line reads "\u2002" + "1." — and every rule downstream that
 * looks for a number at the start of a line silently fails to see it. A space is a
 * space; a soft hyphen and a zero-width space are hyphenation and line-breaking
 * hints that mean nothing once the line breaks are gone.
 */
const SPACE_SEPARATORS = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g;
const INVISIBLE = /[\u00ad\u200b-\u200d\ufeff]/g;

/** Fold typographic whitespace so the frozen rules see ordinary spaces. */
export function normalizeSpaces(text: string): string {
  return text.replace(SPACE_SEPARATORS, " ").replace(INVISIBLE, "");
}

/** A 2-D affine transform as PDF writes it: [a b c d e f]. */
export type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** `m × n`, in PDF's row-vector convention (apply m, then n). */
export function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

/** One positioned piece of text, in device space. */
interface Run {
  x: number;
  y: number;
  /** Advance width of the run, so the gap to the next one can be measured. */
  width: number;
  /** Effective font size after all transforms — the em used by both thresholds. */
  size: number;
  text: string;
}

export interface TextExtractionResult {
  text: string;
  /** Character codes no font mapping covered — the honest measure of coverage. */
  unmappedCodes: number;
  totalCodes: number;
  /** Resource names of fonts with no usable encoding at all. */
  unmappableFonts: string[];
  /** Codes drawn before any font was selected — a different failure from an unmappable one. */
  noFontCodes: number;
}

interface TextState {
  font?: Font;
  fontSize: number;
  charSpacing: number;
  wordSpacing: number;
  /** Horizontal scaling as a factor (Tz / 100). */
  horizontal: number;
  leading: number;
  rise: number;
  /** Text matrix and line matrix. */
  tm: Matrix;
  tlm: Matrix;
}

function freshState(): TextState {
  return {
    fontSize: 0,
    charSpacing: 0,
    wordSpacing: 0,
    horizontal: 1,
    leading: 0,
    rise: 0,
    tm: [...IDENTITY] as Matrix,
    tlm: [...IDENTITY] as Matrix,
  };
}

/** A fresh font cache, so a caller extracting many pages reuses parsed fonts. */
export function newFontCache(doc: PdfDocument): FontCache {
  return new FontCache(doc);
}

export { FontCache } from "./fonts.js";

/** Extract the text of one page (or any content stream) as plain text. */
export function extractContentText(
  doc: PdfDocument,
  content: Buffer,
  resources: PdfDict,
  cache: FontCache = new FontCache(doc),
): TextExtractionResult {
  const runs: Run[] = [];
  const counters = { unmapped: 0, total: 0, noFont: 0 };
  interpret(doc, content, resources, cache, runs, counters, [...IDENTITY] as Matrix, 0);
  return {
    text: assemble(runs),
    unmappedCodes: counters.unmapped,
    totalCodes: counters.total,
    noFontCodes: counters.noFont,
    unmappableFonts: [...cache.unmappable].sort(),
  };
}

// --------------------------------------------------------------- interpret

function interpret(
  doc: PdfDocument,
  content: Buffer,
  resources: PdfDict,
  cache: FontCache,
  runs: Run[],
  counters: { unmapped: number; total: number; noFont: number },
  initialCtm: Matrix,
  depth: number,
): void {
  const lexer = new Lexer(content, 0);
  const operands: LexValue[] = [];
  const ctmStack: Matrix[] = [];
  let ctm = initialCtm;
  let state = freshState();

  const num = (fromEnd: number): number => {
    const value = operands[operands.length + fromEnd];
    return typeof value === "number" ? value : 0;
  };

  /** Draw a string, recording one run and advancing the text matrix. */
  const show = (bytes: Buffer): void => {
    const font = state.font;
    if (font === undefined) {
      counters.total += bytes.length;
      counters.unmapped += bytes.length;
      // Distinct from a code the font could not map: here there is no font at all.
      counters.noFont += bytes.length;
      return;
    }
    const combined = multiply(state.tm, ctm);
    const xScale = Math.hypot(combined[0], combined[1]) || 1;
    const yScale = Math.hypot(combined[2], combined[3]) || 1;
    const size = Math.abs(state.fontSize) * yScale;

    let text = "";
    let advance = 0; // in text space, before the device transform
    const step = font.codeBytes;
    for (let i = 0; i + step <= bytes.length; i += step) {
      let code = 0;
      for (let j = 0; j < step; j++) code = (code << 8) | (bytes[i + j] as number);
      counters.total++;
      const glyph = font.decode(code);
      if (glyph === undefined) counters.unmapped++;
      else text += glyph;
      const wordSpace = step === 1 && code === 0x20 ? state.wordSpacing : 0;
      advance += ((font.width(code) / GLYPH_SPACE) * state.fontSize + state.charSpacing + wordSpace) * state.horizontal;
    }

    if (text !== "") {
      runs.push({
        x: combined[4],
        y: combined[5] + state.rise * yScale,
        width: advance * xScale,
        size: size === 0 ? 1 : size,
        text,
      });
    }
    state.tm = multiply([1, 0, 0, 1, advance, 0], state.tm);
  };

  /** A TJ adjustment: move back (positive numbers move left) without drawing. */
  const adjust = (amount: number): void => {
    const shift = (-amount / GLYPH_SPACE) * state.fontSize * state.horizontal;
    state.tm = multiply([1, 0, 0, 1, shift, 0], state.tm);
  };

  const nextLine = (dx: number, dy: number): void => {
    state.tlm = multiply([1, 0, 0, 1, dx, dy], state.tlm);
    state.tm = [...state.tlm] as Matrix;
  };

  for (;;) {
    const token = lexer.next();
    if (token === undefined) break;
    if (!isKeyword(token)) {
      operands.push(token);
      if (operands.length > 64) operands.shift();
      continue;
    }

    switch (token.value) {
      case "q":
        ctmStack.push([...ctm] as Matrix);
        break;
      case "Q": {
        const restored = ctmStack.pop();
        if (restored !== undefined) ctm = restored;
        break;
      }
      case "cm":
        ctm = multiply([num(-6), num(-5), num(-4), num(-3), num(-2), num(-1)], ctm);
        break;
      case "BT":
        // BT resets the text matrices but not the graphics state, which is exactly
        // why a producer can wrap every single run in its own BT…ET.
        state.tm = [...IDENTITY] as Matrix;
        state.tlm = [...IDENTITY] as Matrix;
        break;
      case "ET":
        break;
      case "Tf": {
        state.fontSize = num(-1);
        const fontName = operands[operands.length - 2];
        state.font = undefined;
        if (isName(fontName as PdfValue)) {
          const label = (fontName as { name: string }).name;
          const fonts = doc.dict(resources.get("Font"));
          const fontDict = doc.dict(fonts?.get(label));
          if (fontDict !== undefined) {
            const font = cache.get(fontDict, label);
            if (!font.unmappable) state.font = font;
          } else {
            cache.unmappable.add(label);
          }
        }
        break;
      }
      case "Tc":
        state.charSpacing = num(-1);
        break;
      case "Tw":
        state.wordSpacing = num(-1);
        break;
      case "Tz":
        state.horizontal = num(-1) / 100;
        break;
      case "TL":
        state.leading = num(-1);
        break;
      case "Ts":
        state.rise = num(-1);
        break;
      case "Td":
        nextLine(num(-2), num(-1));
        break;
      case "TD":
        state.leading = -num(-1);
        nextLine(num(-2), num(-1));
        break;
      case "Tm":
        state.tlm = [num(-6), num(-5), num(-4), num(-3), num(-2), num(-1)];
        state.tm = [...state.tlm] as Matrix;
        break;
      case "T*":
        nextLine(0, -state.leading);
        break;
      case "Tj": {
        const value = operands[operands.length - 1];
        if (isString(value as PdfValue)) show((value as { bytes: Buffer }).bytes);
        break;
      }
      case "'": {
        nextLine(0, -state.leading);
        const value = operands[operands.length - 1];
        if (isString(value as PdfValue)) show((value as { bytes: Buffer }).bytes);
        break;
      }
      case '"': {
        state.wordSpacing = num(-3);
        state.charSpacing = num(-2);
        nextLine(0, -state.leading);
        const value = operands[operands.length - 1];
        if (isString(value as PdfValue)) show((value as { bytes: Buffer }).bytes);
        break;
      }
      case "TJ": {
        const array = operands[operands.length - 1];
        if (Array.isArray(array)) {
          for (const item of array) {
            if (isString(item)) show(item.bytes);
            else if (typeof item === "number") adjust(item);
          }
        }
        break;
      }
      case "Do": {
        if (depth >= MAX_XOBJECT_DEPTH) break;
        const target = operands[operands.length - 1];
        if (!isName(target as PdfValue)) break;
        const xobjects = doc.dict(resources.get("XObject"));
        const xobject = doc.resolve(xobjects?.get((target as { name: string }).name));
        if (!isStream(xobject) || !isName(doc.get(xobject.dict, "Subtype"), "Form")) break;
        let inner: Buffer;
        try {
          inner = decodeStream(xobject, (value) => doc.resolve(value));
        } catch {
          break;
        }
        // A form carries its own /Matrix, and its text belongs at the position that
        // matrix puts it — so it joins the page's runs rather than being appended.
        const formMatrix = doc.resolve(xobject.dict.get("Matrix"));
        const matrix: Matrix = Array.isArray(formMatrix) && formMatrix.length === 6
          ? (formMatrix.map((value) => doc.num(value) ?? 0) as Matrix)
          : ([...IDENTITY] as Matrix);
        const innerResources = doc.dict(xobject.dict.get("Resources")) ?? resources;
        interpret(doc, inner, innerResources, cache, runs, counters, multiply(matrix, ctm), depth + 1);
        break;
      }
      default:
        break;
    }
    operands.length = 0;
  }

  // A content stream that ends inside a text object leaves `state` unused; naming
  // it here keeps the compiler honest about the assignment above being deliberate.
  void state;
}

// ---------------------------------------------------------------- assemble

/**
 * Group runs into lines and join them.
 *
 * Lines are found by baseline: runs are taken in descending y, and a run whose
 * baseline is within a fraction of an em of the current line joins it. Within a
 * line the runs are ordered by x and separated by a space when the measured gap is
 * wide enough — which is where the glyph widths earn their keep.
 */
export function assemble(runs: Run[]): string {
  if (runs.length === 0) return "";
  const sorted = [...runs].sort((a, b) => b.y - a.y || a.x - b.x);

  const lines: Run[][] = [];
  let current: Run[] = [];
  let baseline = (sorted[0] as Run).y;
  for (const run of sorted) {
    const tolerance = Math.max(1, run.size * LINE_TOLERANCE_EM);
    if (current.length > 0 && Math.abs(run.y - baseline) > tolerance) {
      lines.push(current);
      current = [];
    }
    if (current.length === 0) baseline = run.y;
    current.push(run);
  }
  if (current.length > 0) lines.push(current);

  const rendered = lines.map((line) => {
    const ordered = [...line].sort((a, b) => a.x - b.x);
    let text = "";
    let cursor: number | undefined;
    for (const run of ordered) {
      if (cursor !== undefined) {
        const gap = run.x - cursor;
        if (gap > run.size * WORD_GAP_EM && !text.endsWith(" ") && !run.text.startsWith(" ")) text += " ";
      }
      text += run.text;
      cursor = run.x + run.width;
    }
    return stripControlCharacters(normalizeSpaces(text)).replace(/[ \t]+/g, " ").trimEnd();
  });

  return rendered
    .join("\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
