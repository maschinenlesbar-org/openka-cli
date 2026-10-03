// An OCR mode turned into a perceiver that is ready to run. Both CLIs and any
// library caller go through here, so "is the engine there" is answered once, up
// front, rather than as an abstention on every page of the run.

import { OpenKaError, assertValid, type Problem } from "@maschinenlesbar.org/openka-lib-errors";
import { abstainingPerceiver, assertPerceiverOptions, type Perceiver, type PerceiverOptions } from "./perceiver.js";
import { TesseractCliPerceiver } from "./tesseract-cli.js";
import { TesseractJsPerceiver } from "./tesseract-js.js";

/** The OCR modes: strict mode (no model), the native binary, the WASM build. */
export const OCR_MODES = ["off", "tesseract", "tesseract-js"] as const;
export type OcrMode = (typeof OCR_MODES)[number];

/** A mode `createPerceiver` knows. */
export const ocrModeProblem: Problem<string> = (value) =>
  (OCR_MODES as readonly string[]).includes(value) ? undefined : `Allowed choices are ${OCR_MODES.join(", ")}.`;

/**
 * Build the perceiver for an OCR mode, ready to use.
 *
 * `off` is strict mode — no model on the line, scanned documents abstain — and
 * takes no options: one given there would be ignored, so it is refused. The other
 * two are the sanctioned narrow perceptual case and must be runnable here: the
 * binary on PATH, or the optional `tesseract.js` module loaded. An engine that is
 * not there is an `OpenKaError` now, not a corpus full of "not installed"
 * abstentions — and not a `ka verify` that reports a false non-reproduction.
 * Throws `OpenKaValidationError` for an unknown mode or a blank option.
 */
export async function createPerceiver(mode: OcrMode, options: PerceiverOptions = {}): Promise<Perceiver> {
  assertValid("mode", mode as string, ocrModeProblem);
  assertPerceiverOptions(options);
  if (mode === "off") {
    for (const name of ["language", "requireVersion", "traineddataPath"] as const) {
      assertValid(name, options[name], (value) =>
        value === undefined ? undefined : 'Only applies with an OCR engine (tesseract or tesseract-js); with "off" no model runs and it would be ignored.',
      );
    }
    return abstainingPerceiver;
  }
  if (mode === "tesseract") {
    const perceiver = new TesseractCliPerceiver(options);
    if (!perceiver.available()) {
      throw new OpenKaError(
        "--ocr tesseract needs the `tesseract` binary on PATH. Install it, pick --ocr tesseract-js " +
          "(after `npm install tesseract.js`), or leave OCR off and accept the abstentions.",
      );
    }
    return perceiver;
  }
  const perceiver = new TesseractJsPerceiver(options);
  if (!(await perceiver.load())) {
    throw new OpenKaError(
      "--ocr tesseract-js needs the optional `tesseract.js` package. Install it with " +
        "`npm install tesseract.js`, or use --ocr tesseract with the native binary.",
    );
  }
  return perceiver;
}
