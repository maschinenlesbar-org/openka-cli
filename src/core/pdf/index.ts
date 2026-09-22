// Public surface of the PDF reader: text for the `text_layer` tier, embedded
// images for the `ocr` tier, and an honest account of what could not be read.

import { ParseError } from "../errors.js";
import { PdfDocument } from "./document.js";
import { extractContentText, newFontCache } from "./text.js";
import { IMAGE_FILTERS, filterChain } from "./filters.js";
import { isName, isStream } from "./objects.js";

export { PdfDocument } from "./document.js";
export { extractContentText, assemble, normalizeSpaces, WORD_GAP_EM, LINE_TOLERANCE_EM } from "./text.js";
export { FontCache, GLYPH_SPACE } from "./fonts.js";
export * from "./filters.js";
export * from "./objects.js";

export interface PdfPageText {
  page: number;
  text: string;
  unmappedCodes: number;
  totalCodes: number;
}

export interface PdfTextResult {
  pages: PdfPageText[];
  /** All pages joined with a form feed, the form the extractors parse. */
  text: string;
  /** Reasons the reader could not do its job fully — each one drives an abstention. */
  problems: string[];
  /** Share of character codes no font mapping covered, 0..1. */
  unmappedRatio: number;
  /** True when the document has no text-showing operators at all (a scan). */
  imageOnly: boolean;
  /** Content streams refused outright — an encrypted or unsupported filter. */
  undecodableStreams: number;
  version: string;
  pageCount: number;
}

/** Page separator in the joined text. `\f` is what `pdftotext` uses too. */
export const PAGE_SEPARATOR = "\f";

/**
 * Extract the text layer of a PDF.
 *
 * Never throws for a merely difficult document: a page whose content stream will
 * not decode contributes no text and one entry in `problems`. It throws only when
 * the bytes are not a PDF at all, or when the document is encrypted — cases where
 * there is nothing to be salvaged and the tier must abstain outright.
 */
export function extractPdfText(bytes: Buffer): PdfTextResult {
  const doc = PdfDocument.load(bytes);
  if (doc.encrypted) {
    throw new ParseError("Encrypted PDF — this extractor does not decrypt documents");
  }
  const cache = newFontCache(doc);
  const pages = doc.pages();
  const problems: string[] = [];
  const results: PdfPageText[] = [];
  let unmapped = 0;
  let total = 0;

  let undecodable = 0;
  for (const page of pages) {
    if (page.undecodable.length > 0) {
      undecodable += page.undecodable.length;
      problems.push(
        `page ${page.number}: could not decode ${page.undecodable.length} content stream(s) ` +
          `(filter ${page.undecodable.join(", ")})`,
      );
    }
    if (page.content.length === 0) {
      if (page.undecodable.length === 0) problems.push(`page ${page.number}: no decodable content stream`);
      results.push({ page: page.number, text: "", unmappedCodes: 0, totalCodes: 0 });
      continue;
    }
    const extracted = extractContentText(doc, page.content, page.resources, cache);
    unmapped += extracted.unmappedCodes;
    total += extracted.totalCodes;
    results.push({
      page: page.number,
      text: extracted.text,
      unmappedCodes: extracted.unmappedCodes,
      totalCodes: extracted.totalCodes,
    });
    if (extracted.unmappableFonts.length > 0) {
      problems.push(`page ${page.number}: no usable encoding for font(s) ${extracted.unmappableFonts.join(", ")}`);
    } else if (extracted.noFontCodes > 0) {
      // Text drawn before any font was selected — a `Tj` ahead of its `Tf`.
      problems.push(
        `page ${page.number}: ${extracted.noFontCodes} of ${extracted.totalCodes} character code(s) ` +
          "were drawn with no font selected",
      );
    } else if (extracted.unmappedCodes > 0) {
      // A font was selected and could not map these codes — a partly modelled
      // encoding, say a /Differences list that names only some of them.
      problems.push(
        `page ${page.number}: ${extracted.unmappedCodes} of ${extracted.totalCodes} character code(s) ` +
          "have no mapping in the selected font",
      );
    }
  }

  if (pages.length === 0) problems.push("no pages found");
  return {
    pages: results,
    text: results.map((page) => page.text).join(PAGE_SEPARATOR),
    problems,
    unmappedRatio: total === 0 ? 0 : unmapped / total,
    // "No text-showing operators" only means "a scan" when we actually got to look.
    // A page whose content stream we refused has unknown text, and calling that
    // image-only sent the operator to OCR, which cannot decode it either.
    imageOnly: total === 0 && undecodable === 0,
    undecodableStreams: undecodable,
    version: doc.version,
    pageCount: pages.length,
  };
}

export interface PdfImage {
  page: number;
  /** Object name inside the page resources, for traceability. */
  name: string;
  /** `jpeg`, `jpeg2000`, `jbig2` or `ccitt` — what the raw bytes actually are. */
  format: string;
  width: number;
  height: number;
  /** The image bytes exactly as embedded, ready to hand to a perceiver. */
  data: Buffer;
}

const FORMAT_BY_FILTER: Record<string, string> = {
  DCTDecode: "jpeg",
  JPXDecode: "jpeg2000",
  JBIG2Decode: "jbig2",
  CCITTFaxDecode: "ccitt",
};

/**
 * Pull the embedded images out of a PDF, without rasterising anything.
 *
 * Scanned documents are almost always one compressed image per page, so handing
 * those bytes straight to OCR needs no rendering engine — which is why the line can
 * do the `ocr` tier with no graphics dependency at all. Images in formats that are
 * only meaningful once rendered (raw Flate bitmaps) are skipped; the caller then
 * has fewer images than pages and abstains for the pages it could not cover.
 */
export function extractPdfImages(bytes: Buffer): { images: PdfImage[]; pageCount: number; skipped: string[] } {
  const doc = PdfDocument.load(bytes);
  if (doc.encrypted) throw new ParseError("Encrypted PDF — this extractor does not decrypt documents");
  const images: PdfImage[] = [];
  const skipped: string[] = [];
  const pages = doc.pages();

  for (const page of pages) {
    const xobjects = doc.dict(page.resources.get("XObject"));
    if (xobjects === undefined) continue;
    for (const name of [...xobjects.keys()].sort()) {
      const xobject = doc.resolve(xobjects.get(name));
      if (!isStream(xobject) || !isName(doc.get(xobject.dict, "Subtype"), "Image")) continue;
      const { filters } = filterChain(xobject.dict, (value) => doc.resolve(value));
      const imageFilter = filters.find((filter) => IMAGE_FILTERS.has(filter));
      if (imageFilter === undefined) {
        skipped.push(`page ${page.number} image ${name}: filter ${filters.join("+") || "none"} needs rendering`);
        continue;
      }
      if (filters.length > 1) {
        skipped.push(`page ${page.number} image ${name}: filter chain ${filters.join("+")} is not supported`);
        continue;
      }
      images.push({
        page: page.number,
        name,
        format: FORMAT_BY_FILTER[imageFilter] as string,
        width: doc.num(xobject.dict.get("Width")) ?? 0,
        height: doc.num(xobject.dict.get("Height")) ?? 0,
        data: xobject.raw,
      });
    }
  }
  return { images, pageCount: pages.length, skipped };
}
