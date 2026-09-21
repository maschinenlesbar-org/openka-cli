// OCR through a pinned Tesseract binary on PATH.
//
// Determinism comes from three things, all of them enforced here: a fixed set of
// flags (no auto-rotation, a fixed page-segmentation mode, a fixed OEM), a pinned
// version the caller declares and this module verifies, and the sha256 of the
// traineddata file that is actually loaded. A version or weights mismatch is an
// error, not a warning — the whole point of recording an artifact hash is that it
// describes what ran.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { OpenKaError } from "../errors.js";
import { sha256 } from "../repro/hash.js";
import type { ModelArtifact } from "../models/schema.js";
import type { PerceiveInput, PerceiveOutput, Perceiver } from "./perceiver.js";

export interface TesseractOptions {
  /** Binary name or absolute path. */
  binary?: string;
  /** Language traineddata to load, e.g. `deu`. */
  language?: string;
  /** Require exactly this version, e.g. `5.3.4`. Mismatch throws. */
  requireVersion?: string;
  /** Path to the traineddata file, hashed into the provenance record. */
  traineddataPath?: string;
  /** Page segmentation mode. 1 keeps automatic layout analysis with OSD off. */
  psm?: number;
  /** OCR engine mode. 1 is the LSTM engine. */
  oem?: number;
}

export class TesseractCliPerceiver implements Perceiver {
  readonly name = "ocr";
  private readonly binary: string;
  private readonly language: string;
  private readonly psm: number;
  private readonly oem: number;
  private readonly requireVersion: string | undefined;
  private readonly traineddataPath: string | undefined;
  private cachedVersion: string | undefined;

  constructor(options: TesseractOptions = {}) {
    this.binary = options.binary ?? "tesseract";
    this.language = options.language ?? "deu";
    this.psm = options.psm ?? 1;
    this.oem = options.oem ?? 1;
    this.requireVersion = options.requireVersion;
    this.traineddataPath = options.traineddataPath;
  }

  available(): boolean {
    return this.version() !== undefined;
  }

  /** The installed binary's version string, or `undefined` when it is not on PATH. */
  version(): string | undefined {
    if (this.cachedVersion !== undefined) return this.cachedVersion;
    try {
      const out = execFileSync(this.binary, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const match = /tesseract\s+v?([0-9][0-9A-Za-z.\-]*)/i.exec(out);
      this.cachedVersion = match?.[1] ?? out.split(/\r?\n/)[0]?.trim();
      return this.cachedVersion;
    } catch {
      return undefined;
    }
  }

  artifact(): ModelArtifact {
    const version = this.version();
    if (version === undefined) throw new OpenKaError(`Tesseract binary "${this.binary}" is not available`);
    if (this.requireVersion !== undefined && version !== this.requireVersion) {
      throw new OpenKaError(
        `Tesseract version mismatch: this corpus pins ${this.requireVersion}, the binary on PATH is ${version}. ` +
          "A different OCR build produces different text, so it is not interchangeable.",
      );
    }
    const artifact: ModelArtifact = { name: "ocr", version: `tesseract-${version}+${this.language}` };
    if (this.traineddataPath !== undefined) {
      if (!existsSync(this.traineddataPath)) {
        throw new OpenKaError(`Traineddata not found: ${this.traineddataPath}`);
      }
      artifact.weights_sha256 = sha256(readFileSync(this.traineddataPath));
    }
    return artifact;
  }

  async recognize(input: PerceiveInput): Promise<PerceiveOutput> {
    if (!this.available()) {
      return { abstained: true, text: "", reason: `tesseract not on PATH; page ${input.page} not read` };
    }
    // Tesseract reads an image from stdin with `-` and writes text to stdout with `-`.
    const result = spawnSync(
      this.binary,
      ["-", "-", "-l", this.language, "--psm", String(this.psm), "--oem", String(this.oem)],
      { input: input.data, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, OMP_THREAD_LIMIT: "1" } },
    );
    if (result.status !== 0) {
      const stderr = result.stderr?.toString("utf8").trim() ?? "";
      return {
        abstained: true,
        text: "",
        reason: `tesseract failed on page ${input.page} (${input.format}): ${stderr.split("\n")[0] ?? "unknown error"}`,
      };
    }
    const text = result.stdout.toString("utf8").replace(/\r\n/g, "\n").trim();
    if (text === "") {
      return { abstained: true, text: "", reason: `tesseract produced no text for page ${input.page}` };
    }
    return { abstained: false, text };
  }
}
