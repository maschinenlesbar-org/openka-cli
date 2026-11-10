// A URL's userinfo, kept out of every message and log line the engine and the
// transport write. Not re-exported from the package root.

/** A scheme spelled as one: `<scheme>://`. */
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/**
 * `url` without its userinfo, for a message or a log. A URL that spells its scheme
 * (`<scheme>://`) and parses loses its user name and password as WHATWG reads them.
 * One that does not parse, or one typed without its scheme (`user:pw@host`, or
 * `TOKEN:@host`, which parses with the token as its scheme), has everything before
 * the last `@` of its authority (up to the first `/`, `?`, `#` or `\`) replaced by
 * `***`: such a value was quoted with its password (security audit 2026-10-27).
 */
export function withoutUserinfo(url: string): string {
  if (SCHEME.test(url)) {
    try {
      const parsed = new URL(url);
      parsed.username = "";
      parsed.password = "";
      return parsed.href;
    } catch {
      // read as text below
    }
  }
  const scheme = SCHEME.exec(url)?.[0] ?? "";
  const rest = url.slice(scheme.length);
  const end = rest.search(/[/?#\\]/);
  const at = (end === -1 ? rest : rest.slice(0, end)).lastIndexOf("@");
  return at === -1 ? url : `${scheme}***${rest.slice(at)}`;
}

/** Whether `url` spells its scheme (`<scheme>://`), so a message may name the scheme it parsed to. */
export function spellsScheme(url: string): boolean {
  return SCHEME.test(url);
}
