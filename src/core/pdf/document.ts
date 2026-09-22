// Loading a PDF's object graph and page tree.
//
// Deliberately, this does *not* read the cross-reference table. Parliament PDFs are
// produced by a long tail of tools and the xref is the part that is most often
// wrong (stale offsets after an incremental update, byte-offset drift from a
// transfer that rewrote line endings). Instead the whole file is scanned for
// `N G obj` headers and every object stream is expanded. That is deterministic,
// order-defined, and recovers documents a strict xref reader would reject — while
// still refusing anything genuinely unreadable rather than guessing.

import { ParseError } from "../errors.js";
import { decodeStream, filterChain } from "./filters.js";
import { Lexer } from "./lexer.js";
import {
  isDict,
  isName,
  isRef,
  isStream,
  type PdfDict,
  type PdfStream,
  type PdfValue,
} from "./objects.js";

export interface PdfPage {
  /** 1-based page number in reading order. */
  number: number;
  dict: PdfDict;
  /** The page's content streams, concatenated in order. */
  content: Buffer;
  /**
   * Filter chains on this page's content streams that could not be decoded.
   *
   * Non-empty means the page's text is missing *because we refused it*, not
   * because there is none — which is a different fact and a different repair.
   */
  undecodable: string[];
  resources: PdfDict;
}

const OBJ_HEADER = /(?<![0-9])(\d{1,10})\s+(\d{1,5})\s+obj\b/g;

/** An object stream that would not decode, and what it took with it. */
export interface LostObjectStream {
  /** The object number of the `ObjStm` itself. */
  object: number;
  /** Its filter chain, or `unknown` when it declares none we could name. */
  filters: string;
  /** How many objects it said it held (`/N`). */
  count: number;
}

export class PdfDocument {
  private readonly objects = new Map<number, PdfValue>();
  private readonly offsets = new Map<number, number>();
  readonly trailers: PdfDict[] = [];
  /** Object streams that would not decode; their objects are missing from `objects`. */
  readonly lostObjectStreams: LostObjectStream[] = [];
  /** True when the document declares an /Encrypt dictionary. */
  readonly encrypted: boolean;

  private constructor(readonly buf: Buffer) {
    this.scanObjects();
    this.collectTrailers();
    this.expandObjectStreams();
    this.encrypted = this.trailers.some((trailer) => trailer.has("Encrypt"));
  }

  /** Parse a PDF from bytes. Throws `ParseError` when the file is not a PDF. */
  static load(buf: Buffer): PdfDocument {
    const head = buf.subarray(0, 1024).toString("latin1");
    if (!head.includes("%PDF-")) throw new ParseError("Not a PDF: missing %PDF- header");
    return new PdfDocument(buf);
  }

  /** The PDF version from the header, e.g. `1.4`. */
  get version(): string {
    const match = /%PDF-(\d+\.\d+)/.exec(this.buf.subarray(0, 1024).toString("latin1"));
    return match?.[1] ?? "unknown";
  }

  // ------------------------------------------------------------- scanning

  private scanObjects(): void {
    const text = this.buf.toString("latin1");
    // `matchAll` takes its own copy of the regex, so the shared `lastIndex` of a
    // module-level /g pattern cannot be carried between calls — a reset by hand is
    // a discipline, and a nested or re-entrant scan would silently skip input.
    for (const match of text.matchAll(OBJ_HEADER)) {
      const num = Number(match[1]);
      // A later definition of the same object number wins: that is what an
      // incremental update means, and scanning forward sees the update last.
      this.offsets.set(num, match.index + match[0].length);
    }
  }

  private collectTrailers(): void {
    const text = this.buf.toString("latin1");
    let at = text.indexOf("trailer");
    while (at >= 0) {
      const lexer = new Lexer(this.buf, at + "trailer".length);
      const value = lexer.next();
      if (isDict(value as PdfValue)) this.trailers.push(value as PdfDict);
      at = text.indexOf("trailer", at + 1);
    }
    // Cross-reference streams carry the same information in an object, so a
    // document written without a classic trailer still yields a /Root.
    for (const num of [...this.offsets.keys()].sort((a, b) => a - b)) {
      const value = this.getObject(num);
      if (isStream(value) && isName(value.dict.get("Type"), "XRef")) this.trailers.push(value.dict);
    }
  }

  private expandObjectStreams(): void {
    for (const num of [...this.offsets.keys()].sort((a, b) => a - b)) {
      const value = this.getObject(num);
      if (!isStream(value) || !isName(value.dict.get("Type"), "ObjStm")) continue;
      let data: Buffer;
      try {
        data = decodeStream(value, (v) => this.resolve(v));
      } catch {
        // An unreadable object stream costs us its objects, not the file — but the
        // objects it held can be page content or a font, so the loss is named. Left
        // silent it showed up as a page that was merely shorter than it should be,
        // which reads as a document that said less, not as one we could not read.
        this.lostObjectStreams.push({
          object: num,
          filters: filterChain(value.dict, (item: PdfValue | undefined) => this.resolve(item)).filters.join("+") || "unknown",
          count: this.num(value.dict.get("N")) ?? 0,
        });
        continue;
      }
      const count = this.num(value.dict.get("N")) ?? 0;
      const first = this.num(value.dict.get("First")) ?? 0;
      const header = new Lexer(data, 0);
      const pairs: [number, number][] = [];
      for (let i = 0; i < count; i++) {
        const objNum = header.next();
        const objOffset = header.next();
        if (typeof objNum !== "number" || typeof objOffset !== "number") break;
        pairs.push([objNum, objOffset]);
      }
      for (const [objNum, objOffset] of pairs) {
        // Objects defined directly in the file take precedence: they are either the
        // original or a later incremental update, both of which outrank a copy.
        if (this.offsets.has(objNum)) continue;
        try {
          const lexer = new Lexer(data, first + objOffset);
          const parsed = lexer.next();
          if (parsed !== undefined && !(typeof parsed === "object" && parsed !== null && "kind" in parsed && parsed.kind === "keyword")) {
            this.objects.set(objNum, parsed as PdfValue);
          }
        } catch {
          /* one bad entry does not spoil the stream */
        }
      }
    }
  }

  // ------------------------------------------------------------- accessors

  /** Fetch object `num`, parsing it on first use. */
  getObject(num: number): PdfValue | undefined {
    const cached = this.objects.get(num);
    if (cached !== undefined) return cached;
    const offset = this.offsets.get(num);
    if (offset === undefined) return undefined;
    let value: PdfValue;
    try {
      const lexer = new Lexer(this.buf, offset);
      value = lexer.readIndirectBody((length) => this.resolve(length) ?? null);
    } catch {
      return undefined;
    }
    this.objects.set(num, value);
    return value;
  }

  /** Follow indirect references until a direct value is reached. */
  resolve(value: PdfValue | undefined): PdfValue | undefined {
    let current = value;
    for (let hops = 0; isRef(current) && hops < 32; hops++) {
      current = this.getObject(current.num);
    }
    return isRef(current) ? undefined : current;
  }

  /** Resolve a dictionary entry. */
  get(dict: PdfDict | undefined, key: string): PdfValue | undefined {
    if (dict === undefined) return undefined;
    return this.resolve(dict.get(key));
  }

  num(value: PdfValue | undefined): number | undefined {
    const resolved = this.resolve(value);
    return typeof resolved === "number" ? resolved : undefined;
  }

  dict(value: PdfValue | undefined): PdfDict | undefined {
    const resolved = this.resolve(value);
    if (isDict(resolved)) return resolved;
    if (isStream(resolved)) return resolved.dict;
    return undefined;
  }

  /** The document catalog, found via a trailer /Root or by type as a fallback. */
  catalog(): PdfDict | undefined {
    for (const trailer of this.trailers) {
      const root = this.dict(trailer.get("Root"));
      if (root !== undefined && root.has("Pages")) return root;
    }
    for (const num of [...this.offsets.keys()].sort((a, b) => a - b)) {
      const value = this.resolve(this.getObject(num));
      if (isDict(value) && isName(value.get("Type"), "Catalog")) return value;
    }
    return undefined;
  }

  // ----------------------------------------------------------- page tree

  /**
   * The pages in reading order. Walks the page tree from the catalog; if that is
   * missing or broken, falls back to every object of /Type /Page in object-number
   * order, which is the order they were written in.
   */
  pages(): PdfPage[] {
    const collected: PdfDict[] = [];
    const root = this.dict(this.catalog()?.get("Pages"));
    if (root !== undefined) this.walkPages(root, collected, new Set(), {});
    if (collected.length === 0) {
      for (const num of [...this.offsets.keys(), ...this.objects.keys()].sort((a, b) => a - b)) {
        const value = this.resolve(this.getObject(num));
        if (isDict(value) && isName(value.get("Type"), "Page")) collected.push(value);
      }
    }
    return collected.map((dict, i) => ({
      number: i + 1,
      dict,
      ...this.pageContent(dict),
      resources: this.dict(dict.get("Resources")) ?? new Map(),
    }));
  }

  private walkPages(node: PdfDict, out: PdfDict[], seen: Set<PdfDict>, inherited: Record<string, PdfValue>): void {
    if (seen.has(node) || out.length > 10_000) return;
    seen.add(node);
    const next = { ...inherited };
    for (const key of ["Resources", "MediaBox", "CropBox", "Rotate"]) {
      const value = node.get(key);
      if (value !== undefined) next[key] = value;
    }
    const kids = this.resolve(node.get("Kids"));
    if (Array.isArray(kids)) {
      for (const kid of kids) {
        const child = this.dict(kid);
        if (child !== undefined) this.walkPages(child, out, seen, next);
      }
      return;
    }
    if (isName(node.get("Type"), "Pages")) return;
    // A leaf: apply the inherited attributes it did not define itself.
    for (const [key, value] of Object.entries(next)) {
      if (!node.has(key)) node.set(key, value);
    }
    out.push(node);
  }

  private pageContent(page: PdfDict): { content: Buffer; undecodable: string[] } {
    const contents = this.resolve(page.get("Contents"));
    const streams: PdfStream[] = [];
    if (isStream(contents)) streams.push(contents);
    else if (Array.isArray(contents)) {
      for (const item of contents) {
        const resolved = this.resolve(item);
        if (isStream(resolved)) streams.push(resolved);
      }
    }
    const parts: Buffer[] = [];
    const undecodable: string[] = [];
    for (const stream of streams) {
      try {
        parts.push(decodeStream(stream, (value) => this.resolve(value)));
        parts.push(Buffer.from("\n"));
      } catch {
        // A stream we cannot decode contributes nothing — but *which* nothing
        // matters. The separator used to be pushed here too, so the page was never
        // empty, the "no decodable content stream" check could not fire, and an
        // encrypted document was reported as a scan with a suggestion to run OCR
        // that could not possibly help. Name the filter instead.
        undecodable.push(filterChain(stream.dict, (value: PdfValue | undefined) => this.resolve(value)).filters.join("+") || "unknown");
      }
    }
    return { content: Buffer.concat(parts), undecodable };
  }
}
