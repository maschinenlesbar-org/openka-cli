// Text hygiene applied where upstream bytes become record text.

/**
 * Replace the control characters a terminal, a spreadsheet or an XML reader would
 * act on — C0 except tab, newline and carriage return, DEL, and the C1 block
 * U+0080–U+009F — with a space.
 *
 * A space rather than nothing, because in a PDF text layer such a character
 * usually sits exactly where a space belongs: the Bayern Drucksache 19/6524 prints
 * "Drucksache\b19 / 6524" and "Seite\b2\b/\b4", so deleting the byte would weld
 * two words together. The callers collapse runs of spaces afterwards.
 *
 * This runs at the *extraction* boundary rather than at output, because escaping
 * on the way out would make `ka get --format json` print different bytes from the
 * ones on disk — and those being the same bytes is the property `ka verify`
 * checks. A record whose text is clean is safe in every rendering.
 *
 * These characters are never content. The PDF WinAnsi table alone maps five byte
 * values (0x81, 0x8D, 0x8F, 0x90, 0x9D) straight onto C1 code points, so a text
 * layer can hand us U+009B — the 8-bit form of CSI — as ordinary "text".
 */
export function stripControlCharacters(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, " ");
}
