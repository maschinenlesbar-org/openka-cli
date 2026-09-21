// The PDF object model. PDF's data language is small — booleans, numbers, byte
// strings, names, arrays, dictionaries, streams and indirect references — so it is
// modelled here directly rather than coerced into JSON-ish values, because the
// difference between a name and a string matters when reading a page tree.

export interface PdfName {
  readonly kind: "name";
  readonly name: string;
}

export interface PdfString {
  readonly kind: "string";
  /** PDF strings are byte strings; the encoding depends on where they are used. */
  readonly bytes: Buffer;
}

export interface PdfRef {
  readonly kind: "ref";
  readonly num: number;
  readonly gen: number;
}

export type PdfDict = Map<string, PdfValue>;

export interface PdfStream {
  readonly kind: "stream";
  readonly dict: PdfDict;
  /** Still filter-encoded; `decodeStream` in `filters.ts` unwraps it. */
  readonly raw: Buffer;
}

export type PdfValue =
  | null
  | boolean
  | number
  | PdfName
  | PdfString
  | PdfRef
  | PdfValue[]
  | PdfDict
  | PdfStream;

export function name(value: string): PdfName {
  return { kind: "name", name: value };
}

export function isName(value: PdfValue | undefined, expected?: string): value is PdfName {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "name" &&
    (expected === undefined || value.name === expected)
  );
}

export function isRef(value: PdfValue | undefined): value is PdfRef {
  return typeof value === "object" && value !== null && "kind" in value && value.kind === "ref";
}

export function isStream(value: PdfValue | undefined): value is PdfStream {
  return typeof value === "object" && value !== null && "kind" in value && value.kind === "stream";
}

export function isString(value: PdfValue | undefined): value is PdfString {
  return typeof value === "object" && value !== null && "kind" in value && value.kind === "string";
}

export function isDict(value: PdfValue | undefined): value is PdfDict {
  return value instanceof Map;
}
