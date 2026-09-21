// Library entry point. Everything on the line is usable independently of the CLI:
// the schema and its validators, the store, the deterministic extractors, the PDF
// reader, the source clients and the reproducibility checks.
//
// What is deliberately *not* exported is the factory. Build-time tooling is not a
// runtime dependency, and keeping it out of this graph is what makes the
// "no generative model on the line" rule checkable rather than aspirational
// (see `ka-factory lint`).

export * from "./core/errors.js";
export * from "./core/models/parliaments.js";
export * from "./core/models/schema.js";
export * from "./core/models/validate.js";
export { RECORD_JSON_SCHEMA } from "./core/models/json-schema.js";

export * from "./core/repro/canonical.js";
export * from "./core/repro/hash.js";
export * from "./core/repro/version.js";
export * from "./core/repro/verify.js";

export * from "./core/http/http.js";
export * from "./core/http/query.js";
export * from "./core/http/engine.js";

export * from "./core/store/store.js";
export * from "./core/store/file-store.js";
export * from "./core/store/fts.js";
export * from "./core/store/indexer.js";

export * from "./core/extract/segment.js";
export * from "./core/extract/metadata.js";
export * from "./core/extract/validators.js";
export * from "./core/extract/tiers.js";

export * from "./core/perceive/perceiver.js";
export { TesseractCliPerceiver, type TesseractOptions } from "./core/perceive/tesseract-cli.js";
export { TesseractJsPerceiver, type TesseractJsOptions } from "./core/perceive/tesseract-js.js";

export {
  extractPdfText,
  extractPdfImages,
  PdfDocument,
  PAGE_SEPARATOR,
  type PdfTextResult,
  type PdfImage,
} from "./core/pdf/index.js";

export * from "./core/search/search.js";
export * from "./core/search/semantic.js";
export * from "./core/render/render.js";
export * from "./core/pipeline/pipeline.js";

export * from "./sources/base.js";
export * from "./sources/registry.js";
export * from "./sources/pardok.js";
export * from "./sources/berlin.js";
export * from "./sources/bund.js";
export * from "./sources/parlamentsspiegel.js";
export * from "./sources/nordrhein-westfalen.js";
export * from "./sources/saarland.js";
export * from "./sources/sachsen.js";
export * from "./sources/thueringen.js";
export * from "./sources/niedersachsen.js";
export * from "./sources/xml.js";
