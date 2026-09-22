// The PDF reader. These tests build PDFs byte by byte so each layer can be checked
// in isolation, and then run the whole reader over the real Berlin documents in
// `fixtures/`, which is where the awkward cases actually live.

import { deepStrictEqual, match, ok, strictEqual, throws } from "node:assert/strict";
import { stripControlCharacters } from "../src/core/text.js";
import { deflateSync } from "node:zlib";
import { describe, it } from "node:test";
import { Lexer, isKeyword } from "../src/core/pdf/lexer.js";
import { isDict, isName, isRef, isString, type PdfDict } from "../src/core/pdf/objects.js";
import { ascii85Decode, asciiHexDecode, decodeStream, lzwDecode, runLengthDecode } from "../src/core/pdf/filters.js";
import { glyphToUnicode, parseToUnicode, WIN_ANSI } from "../src/core/pdf/encoding.js";
import { multiply, assemble, normalizeSpaces } from "../src/core/pdf/text.js";
import { PdfDocument, extractPdfImages, extractPdfText } from "../src/core/pdf/index.js";
import { readFixture } from "./helpers.js";

function lex(source: string): unknown[] {
  const lexer = new Lexer(Buffer.from(source, "latin1"), 0);
  const out: unknown[] = [];
  for (;;) {
    const token = lexer.next();
    if (token === undefined) break;
    out.push(token);
  }
  return out;
}

describe("PDF lexer", () => {
  it("reads names, including #-escapes", () => {
    const [name] = lex("/A#20B");
    ok(isName(name as never, "A B"));
  });

  it("distinguishes an indirect reference from two numbers", () => {
    const [ref] = lex("12 0 R");
    ok(isRef(ref as never));
    const numbers = lex("12 0");
    deepStrictEqual(numbers, [12, 0]);
  });

  it("reads literal strings with escapes, octal and nesting", () => {
    const [value] = lex(String.raw`(a\(b\)c\n\101)`);
    ok(isString(value as never));
    strictEqual((value as { bytes: Buffer }).bytes.toString("latin1"), "a(b)c\nA");
  });

  it("reads hex strings, ignoring whitespace and padding an odd digit count", () => {
    const [even] = lex("<41 42>");
    strictEqual((even as { bytes: Buffer }).bytes.toString("hex"), "4142");
    // A trailing odd digit is padded with a zero, per ISO 32000-1 §7.3.4.3.
    const [odd] = lex("<4142 4>");
    strictEqual((odd as { bytes: Buffer }).bytes.toString("hex"), "414240");
  });

  it("reads nested dictionaries and arrays", () => {
    const [dict] = lex("<< /A [1 2 /B] /C << /D true >> >>");
    ok(isDict(dict as never));
    const inner = (dict as PdfDict).get("C");
    ok(isDict(inner as never));
    strictEqual((inner as PdfDict).get("D"), true);
  });

  it("skips comments", () => {
    deepStrictEqual(lex("% a comment\n42"), [42]);
  });

  it("makes progress on an unknown delimiter rather than looping", () => {
    const tokens = lex("} 5");
    ok(isKeyword(tokens[0] as never, "}"));
    strictEqual(tokens[1], 5);
  });
});

describe("PDF filters", () => {
  it("decodes ASCIIHex, ASCII85 and RunLength", () => {
    strictEqual(asciiHexDecode(Buffer.from("48656c6c6f>")).toString(), "Hello");
    strictEqual(ascii85Decode(Buffer.from("87cURD]i,\"Ebo80~>")).toString(), "Hello World!");
    strictEqual(runLengthDecode(Buffer.from([2, 65, 66, 67, 254, 68, 128])).toString(), "ABCDDD");
  });

  it("decodes LZW", () => {
    // The worked example from ISO 32000-1 §7.4.4.2: this encoded stream stands for
    // the byte sequence 45 45 45 45 45 65 45 45 45 66.
    const data = Buffer.from([0x80, 0x0b, 0x60, 0x50, 0x22, 0x0c, 0x0c, 0x85, 0x01]);
    deepStrictEqual([...lzwDecode(data)], [45, 45, 45, 45, 45, 65, 45, 45, 45, 66]);
  });

  it("inflates a Flate stream through the stream API", () => {
    const raw = deflateSync(Buffer.from("hello flate"));
    const dict: PdfDict = new Map([["Filter", { kind: "name", name: "FlateDecode" } as never]]);
    strictEqual(decodeStream({ kind: "stream", dict, raw }).toString(), "hello flate");
  });

  it("refuses an unsupported filter instead of returning partial bytes", () => {
    const dict: PdfDict = new Map([["Filter", { kind: "name", name: "JBIG2Decode" } as never]]);
    throws(() => decodeStream({ kind: "stream", dict, raw: Buffer.from("x") }), /Unsupported stream filter/);
  });
});

describe("PDF encodings", () => {
  it("maps WinAnsi's special 0x80-0x9f block", () => {
    strictEqual(WIN_ANSI[0x80], 0x20ac); // Euro
    strictEqual(WIN_ANSI[0x93], 0x201c); // left double quote
    strictEqual(WIN_ANSI[0xfc], 0x00fc); // u-umlaut
  });

  it("resolves glyph names, including the algorithmic forms", () => {
    strictEqual(glyphToUnicode("germandbls"), 0x00df);
    strictEqual(glyphToUnicode("uni20AC"), 0x20ac);
    strictEqual(glyphToUnicode("a.sc"), 0x61);
    strictEqual(glyphToUnicode("not-a-glyph"), undefined);
  });

  it("parses bfchar and bfrange in a ToUnicode CMap", () => {
    const cmap = `
      /CIDInit /ProcSet findresource begin
      1 begincodespacerange <0000> <FFFF> endcodespacerange
      2 beginbfchar <0003> <0020> <0024> <0041> endbfchar
      1 beginbfrange <0025> <0027> <0042> endbfrange
    `;
    const parsed = parseToUnicode(Buffer.from(cmap, "latin1"));
    strictEqual(parsed.codeBytes, 2);
    strictEqual(parsed.map.get(0x0003), " ");
    strictEqual(parsed.map.get(0x0024), "A");
    strictEqual(parsed.map.get(0x0026), "C");
  });
});

describe("whitespace folding", () => {
  it("folds typographic spaces to a plain space", () => {
    strictEqual(normalizeSpaces("a\u2002b\u00a0c\u3000d"), "a b c d");
  });

  it("drops invisible characters that only mattered before the line breaks went", () => {
    strictEqual(normalizeSpaces("Sil\u00adbe\u200btrennung"), "Silbetrennung");
  });

  it("leaves ordinary text alone", () => {
    strictEqual(normalizeSpaces("Brücken-Zustand 2024"), "Brücken-Zustand 2024");
  });
});

describe("text assembly", () => {
  it("multiplies matrices in PDF's row-vector convention", () => {
    deepStrictEqual(multiply([1, 0, 0, 1, 5, 7], [2, 0, 0, 2, 0, 0]), [2, 0, 0, 2, 10, 14]);
  });

  it("joins runs on one baseline and separates the ones with a real gap", () => {
    const runs = [
      { x: 0, y: 100, width: 20, size: 10, text: "Alt" },
      { x: 20, y: 100, width: 4, size: 10, text: "-" },
      { x: 24, y: 100, width: 40, size: 10, text: "Treptow" },
      { x: 200, y: 100, width: 30, size: 10, text: "rechts" },
      { x: 0, y: 80, width: 30, size: 10, text: "zweite" },
    ];
    strictEqual(assemble(runs), "Alt-Treptow rechts\nzweite");
  });

  it("orders lines top to bottom whatever order the runs arrived in", () => {
    const runs = [
      { x: 0, y: 10, width: 10, size: 10, text: "unten" },
      { x: 0, y: 50, width: 10, size: 10, text: "oben" },
    ];
    strictEqual(assemble(runs), "oben\nunten");
  });
});

// A hand-built PDF: uncompressed, one page, one text run. Small enough to reason
// about, real enough to exercise the object scanner and the content interpreter.
function minimalPdf(text: string): Buffer {
  const content = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  return Buffer.from(
    [
      "%PDF-1.4",
      "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
      "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
      "3 0 obj << /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >> endobj",
      `4 0 obj << /Length ${content.length} >> stream\n${content}\nendstream endobj`,
      "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >> endobj",
      "trailer << /Root 1 0 R >>",
      "%%EOF",
    ].join("\n"),
    "latin1",
  );
}

describe("PDF documents", () => {
  it("reads a minimal document without consulting the xref", () => {
    const doc = PdfDocument.load(minimalPdf("Hallo Welt"));
    strictEqual(doc.version, "1.4");
    strictEqual(doc.pages().length, 1);
    strictEqual(extractPdfText(minimalPdf("Hallo Welt")).text, "Hallo Welt");
  });

  it("rejects bytes that are not a PDF", () => {
    throws(() => PdfDocument.load(Buffer.from("not a pdf")), /Not a PDF/);
  });

  it("refuses an encrypted document rather than emitting empty pages", () => {
    const encrypted = Buffer.from(minimalPdf("x").toString("latin1").replace("trailer << /Root 1 0 R >>", "trailer << /Root 1 0 R /Encrypt 9 0 R >>"), "latin1");
    throws(() => extractPdfText(encrypted), /Encrypted PDF/);
  });

  it("recovers a page even when the trailer is missing", () => {
    const broken = Buffer.from(minimalPdf("Ohne Trailer").toString("latin1").replace("trailer << /Root 1 0 R >>", ""), "latin1");
    strictEqual(extractPdfText(broken).text, "Ohne Trailer");
  });

  it("reports an image-only document instead of pretending it has no text", () => {
    const noText = Buffer.from(minimalPdf("x").toString("latin1").replace(/BT[^e]*ET/, "q Q"), "latin1");
    const result = extractPdfText(noText);
    strictEqual(result.imageOnly, true);
    strictEqual(result.text, "");
  });
});

describe("PDF reader on real documents", () => {
  const pdf = readFixture(
    "berlin",
    "berlin-19-10006",
    "7d0515afe6e596c8913c4353b6b89dbbb4da5c5ae4092a2cecb2a8660bf774ad.bin",
  );

  it("reads a Berlin Schriftliche Anfrage with no unmapped characters", () => {
    const result = extractPdfText(pdf);
    strictEqual(result.unmappedRatio, 0);
    strictEqual(result.imageOnly, false);
    deepStrictEqual(result.problems, []);
    strictEqual(result.pageCount, 4);
  });

  it("keeps the words, the umlauts and the question structure intact", () => {
    const { text } = extractPdfText(pdf);
    match(text, /Schriftliche Anfrage/);
    match(text, /Wann kommen die Solaranlagen nach Pankow\?/);
    match(text, /Senatsverwaltung für/);
    match(text, /Frage 1:/);
    match(text, /Antwort zu 1:/);
  });

  it("produces byte-identical text on a second run", () => {
    strictEqual(extractPdfText(pdf).text, extractPdfText(pdf).text);
  });

  it("finds no embedded images to OCR in a text-layer document", () => {
    const images = extractPdfImages(pdf);
    strictEqual(images.pageCount, 4);
    ok(images.images.every((image) => image.format === "jpeg" || image.format === "jpeg2000" || image.format === "ccitt" || image.format === "jbig2"));
  });

  it("reads a document whose producer wraps every run in its own BT/ET", () => {
    // 19/10041 is the one with `a.`/`b.` sub-items and a date at line start; the
    // regression this pins is text coming out as one word per line.
    const other = readFixture(
      "berlin",
      "berlin-19-10041",
      "1b11b97d7fbfc91f18ac5b101752d8dc25e39c5c64d76858f4b838c6bccc64c0.bin",
    );
    const { text } = extractPdfText(other);
    match(text, /Zu 5\. a\.:/);
    ok(text.split("\n").some((line) => line.split(" ").length > 8), "expected real sentences, not one word per line");
  });
});

describe("control characters in extracted text", () => {
  it("replaces them with a space rather than deleting them", () => {
    // The Bayern Drucksache 19/6524 prints "Drucksache\b19 / 6524" and
    // "Seite\b2\b/\b4" in its text layer — the WinAnsi table maps five byte values
    // straight onto C1 code points, so a control character arrives where a space
    // belongs. Deleting it would weld the words together.
    strictEqual(stripControlCharacters("Drucksache\u000819 / 6524"), "Drucksache 19 / 6524");
    strictEqual(stripControlCharacters("Seite\u00082\u0008/\u00084"), "Seite 2 / 4");
    strictEqual(stripControlCharacters("Titel\u009b31m"), "Titel 31m");
    strictEqual(stripControlCharacters("a\u007fb"), "a b");
  });

  it("keeps the whitespace that carries structure", () => {
    strictEqual(stripControlCharacters("a\tb\nc\rd"), "a\tb\nc\rd");
  });

  it("leaves ordinary German text untouched", () => {
    strictEqual(stripControlCharacters("Brücken & Wege, §3 — 100 %"), "Brücken & Wege, §3 — 100 %");
  });
});
