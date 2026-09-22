// Library entry point. Everything on the line is usable independently of the CLI:
// the schema and its validators, the store, the deterministic extractors, the PDF
// reader, the source clients and the reproducibility checks.
//
// What is deliberately *not* exported is the factory. Build-time tooling is not a
// runtime dependency, and keeping it out of this graph is what makes the
// "no generative model on the line" rule checkable rather than aspirational
// (see `ka-factory lint`).

export * from "@maschinenlesbar.org/openka-lib-errors";
export * from "@maschinenlesbar.org/openka-lib-models";
export * from "@maschinenlesbar.org/openka-lib-models";
export * from "@maschinenlesbar.org/openka-lib-models";
export { RECORD_JSON_SCHEMA } from "@maschinenlesbar.org/openka-lib-models";

export * from "@maschinenlesbar.org/openka-lib-repro";
export * from "@maschinenlesbar.org/openka-lib-repro";
export * from "@maschinenlesbar.org/openka-lib-repro";
export * from "@maschinenlesbar.org/openka-lib-verify";

export * from "@maschinenlesbar.org/openka-lib-http";
export * from "@maschinenlesbar.org/openka-lib-http";
export * from "@maschinenlesbar.org/openka-lib-http";

export * from "@maschinenlesbar.org/openka-lib-store";
export * from "@maschinenlesbar.org/openka-lib-store";
export * from "@maschinenlesbar.org/openka-lib-store";
export * from "@maschinenlesbar.org/openka-lib-store";

export * from "@maschinenlesbar.org/openka-lib-extract";
export * from "@maschinenlesbar.org/openka-lib-extract";
export * from "@maschinenlesbar.org/openka-lib-extract";
export * from "@maschinenlesbar.org/openka-lib-extract";

export * from "@maschinenlesbar.org/openka-lib-perceive";
export { TesseractCliPerceiver, type TesseractOptions } from "@maschinenlesbar.org/openka-lib-perceive";
export { TesseractJsPerceiver, type TesseractJsOptions } from "@maschinenlesbar.org/openka-lib-perceive";

export {
  extractPdfText,
  extractPdfImages,
  PdfDocument,
  PAGE_SEPARATOR,
  type PdfTextResult,
  type PdfImage,
} from "@maschinenlesbar.org/openka-lib-pdf";

export * from "@maschinenlesbar.org/openka-lib-search";
export * from "@maschinenlesbar.org/openka-lib-render";
export * from "@maschinenlesbar.org/openka-lib-pipeline";

export * from "@maschinenlesbar.org/openka-lib-source";
export * from "@maschinenlesbar.org/openka-lib-registry";
export * from "@maschinenlesbar.org/openka-lib-pardok";
export * from "@maschinenlesbar.org/openka-lib-parlamentsspiegel";

// Connectors are re-exported by name, not with `export *`: each declares its own
// `ENTRY` for the registry, and seventeen of those flattened into one namespace
// collide. What a library consumer wants from a connector is its Source anyway.
export { BerlinSource, berlinFeedUrl } from "@maschinenlesbar.org/openka-connector-berlin";
export { BundDipSource } from "@maschinenlesbar.org/openka-connector-bund";
export { NordrheinWestfalenSource } from "@maschinenlesbar.org/openka-connector-nordrhein-westfalen";
export { SaarlandSource } from "@maschinenlesbar.org/openka-connector-saarland";
export { SachsenSource } from "@maschinenlesbar.org/openka-connector-sachsen";
export { ThueringenParldokSource } from "@maschinenlesbar.org/openka-connector-thueringen";
export {
  NiedersachsenSource,
  ANSWER_INDEX,
  type AnswerIndex,
  type AnswerEntry,
} from "@maschinenlesbar.org/openka-connector-niedersachsen";
