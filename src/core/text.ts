// Text hygiene applied where upstream bytes become record text, and again wherever
// upstream text is shown to a human.
//
// One implementation, three intentions. There used to be three implementations:
// `stripControlCharacters` here, `sanitizeForTerminal` in the CLI and
// `sanitizeServerText` in the fetch engine — the last two character-for-character
// identical but for a trailing `.trim()`. Nothing in any of them mentioned the
// others, so a fourth was one "I need to sanitise this" away. The layering reason
// was real (one caller must keep newlines, the others must not), but that belongs
// in an argument, not in a copy.

/** C0 except tab, newline and carriage return; DEL; and the C1 block. */
const CONTROL_KEEPING_WHITESPACE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

/** The same set plus tab, newline and carriage return. */
const CONTROL_ALL = /[\u0000-\u001f\u007f-\u009f]/g;

export interface ControlCharacterOptions {
  /**
   * Keep tab, newline and carriage return, which carry structure rather than
   * formatting. True where the text is stored or rendered as a document; false
   * where it becomes one line of terminal output.
   */
  keepWhitespace?: boolean;
}

/**
 * Replace the control characters a terminal, a spreadsheet or an XML reader would
 * act on with a space.
 *
 * A space rather than nothing, because in a PDF text layer such a character
 * usually sits exactly where a space belongs: the Bayern Drucksache 19/6524 prints
 * "Drucksache\b19 / 6524" and "Seite\b2\b/\b4", so deleting the byte would weld two
 * words together. Callers collapse runs of spaces afterwards.
 */
export function stripControlCharacters(text: string, options: ControlCharacterOptions = {}): string {
  const pattern = options.keepWhitespace === false ? CONTROL_ALL : CONTROL_KEEPING_WHITESPACE;
  return text.replace(pattern, " ");
}
