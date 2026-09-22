# @maschinenlesbar.org/openka-lib-pdf

> A PDF reader written from scratch, because the alternative was a dependency that guesses.

Text extraction is where this project is most likely to be quietly wrong, so the
reader is ours end to end: lexer, object model, stream filters, font metrics,
encodings and a content-stream interpreter.

**It does not read the cross-reference table.** Parliament PDFs come from a long
tail of Word add-ins and print drivers, and the xref is the part most often wrong —
stale offsets after an incremental update, byte drift from a transfer that rewrote
line endings. Scanning for objects directly is slower and far more robust.

**An unsupported filter is never approximated.** `decodeStream` throws, the tier
turns that into an abstention, and the document goes to review.

**Widths matter as much as the mapping.** Without them a reader has to guess where
one word ends and the next begins, and the guess is wrong exactly where documents
are hardest — a hyphenated place name split across two text runs. A declared width
of `0` is a real width, not a missing one: combining marks and the soft hyphen have
one.

This package is part of the **extraction digest**: changing it changes what a
document turns into, so `npm run stamp` and a golden re-freeze are required.

## What is in here

- **`src/document.ts`** — Loading a PDF's object graph and page tree.
- **`src/encoding.ts`** — Turning font byte codes into Unicode.
- **`src/filters.ts`** — Stream filters.
- **`src/fonts.ts`** — Font metrics: what a character code means, and how wide it is.
- **`src/index.ts`** — Public surface of the PDF reader: text for the `text_layer` tier, embedded images for the `ocr` tier, and an honest account of what could not be read.
- **`src/lexer.ts`** — A tokenizer and object parser for PDF syntax (ISO 32000-1 §7.2–7.3).
- **`src/objects.ts`** — The PDF object model.
- **`src/text.ts`** — The content-stream interpreter: PDF drawing operators in, plain text out.

## Public surface

Everything is re-exported from the package root:

```
PdfPage, LostObjectStream, PdfDocument, WIN_ANSI, MAC_ROMAN, STANDARD, baseEncoding, glyphToUnicode, ToUnicodeMap, parseToUnicode, Resolver, IMAGE_FILTERS, decodeStream, filterChain, MAX_INFLATED_BYTES, inflate, applyPredictor, asciiHexDecode, ascii85Decode, runLengthDecode, lzwDecode, GLYPH_SPACE, Font, FontCache, PdfPageText, PdfTextResult, PAGE_SEPARATOR, extractPdfText, PdfImage, extractPdfImages, isWhitespace, isDelimiter, PdfKeyword, LexValue, isKeyword, MAX_NESTING_DEPTH, Lexer, PdfName, PdfString, PdfRef, PdfDict, PdfStream, PdfValue, name, isName, isRef, isStream, isString, isDict, WORD_GAP_EM, LINE_TOLERANCE_EM, normalizeSpaces, Matrix, multiply, TextExtractionResult, newFontCache, extractContentText, assemble
```

## Depends on

- `lib-errors` — the shared error hierarchy
- `lib-text` — control-character stripping

## Tests

`test/pdf.test.ts` — run with:

```bash
npm test -w @maschinenlesbar.org/openka-lib-pdf
```
