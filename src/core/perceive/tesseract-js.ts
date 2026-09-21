// OCR through `tesseract.js`, the WASM build of the same engine.
//
// It is an *optional peer dependency*: nothing installs it for you and the line
// keeps its zero-required-runtime-dependency property. It is imported dynamically
// so that a corpus built without OCR never loads a 10 MB WASM module, and so a
// missing install is an abstention with a clear message rather than a crash.
//
//   npm install tesseract.js          # then: ka sync --ocr tesseract-js
//
// The same determinism rules apply as for the binary: the module version and the
// traineddata hash go into `extraction.model_artifacts`, and a version the corpus
// does not pin is refused.

import { existsSync, readFileSync } from "node:fs";
import { OpenKaError } from "../errors.js";
import { sha256 } from "../repro/hash.js";
import type { ModelArtifact } from "../models/schema.js";
import type { PerceiveInput, PerceiveOutput, Perceiver } from "./perceiver.js";

/** The shape of `tesseract.js` this perceiver uses — kept minimal on purpose. */
interface TesseractJsModule {
  recognize(
    image: Buffer,
    language?: string,
    options?: Record<string, unknown>,
  ): Promise<{ data: { text: string } }>;
}

export interface TesseractJsOptions {
  language?: string;
  /** Require exactly this `tesseract.js` version; a mismatch throws. */
  requireVersion?: string;
  /** Traineddata file to hash into the provenance record. */
  traineddataPath?: string;
  /** Injected module, so tests exercise this class without the real dependency. */
  module?: TesseractJsModule;
  moduleVersion?: string;
}

export class TesseractJsPerceiver implements Perceiver {
  readonly name = "ocr";
  private readonly language: string;
  private readonly requireVersion: string | undefined;
  private readonly traineddataPath: string | undefined;
  private module: TesseractJsModule | undefined;
  private moduleVersion: string | undefined;
  private loadError: string | undefined;

  constructor(options: TesseractJsOptions = {}) {
    this.language = options.language ?? "deu";
    this.requireVersion = options.requireVersion;
    this.traineddataPath = options.traineddataPath;
    this.module = options.module;
    this.moduleVersion = options.moduleVersion;
  }

  /** Load the optional dependency. Resolves to `false` when it is not installed. */
  async load(): Promise<boolean> {
    if (this.module !== undefined) return true;
    try {
      // The specifier is held in a variable on purpose: a literal would make the
      // optional peer dependency a compile-time requirement of the whole project.
      const specifier = "tesseract.js";
      const imported = (await import(specifier)) as unknown as {
        default?: TesseractJsModule;
        recognize?: TesseractJsModule["recognize"];
      };
      const candidate = (imported.recognize ? imported : imported.default) as TesseractJsModule | undefined;
      if (candidate?.recognize === undefined) {
        this.loadError = "tesseract.js does not export recognize()";
        return false;
      }
      this.module = candidate;
      this.moduleVersion ??= await readInstalledVersion();
      return true;
    } catch (err) {
      this.loadError = err instanceof Error ? err.message : String(err);
      return false;
    }
  }

  available(): boolean {
    return this.module !== undefined;
  }

  artifact(): ModelArtifact {
    if (this.module === undefined) {
      throw new OpenKaError(
        `tesseract.js is not installed (${this.loadError ?? "not loaded"}). ` +
          "Install it with `npm install tesseract.js`, or run in strict mode and accept the abstentions.",
      );
    }
    const version = this.moduleVersion ?? "unknown";
    if (this.requireVersion !== undefined && version !== this.requireVersion) {
      throw new OpenKaError(
        `tesseract.js version mismatch: this corpus pins ${this.requireVersion}, the installed module is ${version}.`,
      );
    }
    const artifact: ModelArtifact = { name: "ocr", version: `tesseract.js-${version}+${this.language}` };
    if (this.traineddataPath !== undefined) {
      if (!existsSync(this.traineddataPath)) throw new OpenKaError(`Traineddata not found: ${this.traineddataPath}`);
      artifact.weights_sha256 = sha256(readFileSync(this.traineddataPath));
    }
    return artifact;
  }

  async recognize(input: PerceiveInput): Promise<PerceiveOutput> {
    if (this.module === undefined && !(await this.load())) {
      return {
        abstained: true,
        text: "",
        reason: `tesseract.js is not installed; page ${input.page} not read`,
      };
    }
    try {
      const result = await (this.module as TesseractJsModule).recognize(input.data, this.language);
      const text = (result.data.text ?? "").replace(/\r\n/g, "\n").trim();
      if (text === "") return { abstained: true, text: "", reason: `tesseract.js produced no text for page ${input.page}` };
      return { abstained: false, text };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { abstained: true, text: "", reason: `tesseract.js failed on page ${input.page}: ${reason}` };
    }
  }
}

/** Read the installed module's version from its own package.json. */
async function readInstalledVersion(): Promise<string | undefined> {
  try {
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const manifest = require("tesseract.js/package.json") as { version?: string };
    return manifest.version;
  } catch {
    return undefined;
  }
}
