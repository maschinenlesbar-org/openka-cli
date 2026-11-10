// A URL's userinfo, kept out of every message and log line the engine and the
// transport write. Not re-exported from the package root.

/** A scheme spelled as one: `<scheme>://`. */
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/**
 * `url` without its userinfo, for a message or a log. A URL that spells its scheme
 * (`<scheme>://`) and parses loses its user name and password as WHATWG reads them.
 * One typed without its scheme (`user:pw@host`, or `TOKEN:@host`, which parses with the
 * token as its scheme) has everything before the last `@` of its authority (up to the first
 * `/`, `?`, `#` or `\`) replaced by `***`; one that spells its scheme but does not parse (a
 * `/` or `#` in the password) everything up to the last `@` of the value; one whose scheme is
 * mistyped before slashes (`http//user:pw@host`, the colon left out; `htp:/user:pw@host`)
 * everything between the first slashes and the last `@`. Such values were quoted with their
 * password (security audit 2026-10-27, F6 and F7).
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
  // A spelled scheme got here only because the URL does not parse: its userinfo may hold "/".
  const end = scheme !== "" ? -1 : rest.search(/[/?#\\]/);
  const at = (end === -1 ? rest : rest.slice(0, end)).lastIndexOf("@");
  if (at !== -1) return `${scheme}***${rest.slice(at)}`;
  if (scheme !== "") return url;
  // A scheme mistyped before slashes: the userinfo starts after them.
  const slashes = /[/\\]+/.exec(url);
  const last = url.lastIndexOf("@");
  if (slashes === null || slashes.index + slashes[0].length >= last) return url;
  return `${url.slice(0, slashes.index + slashes[0].length)}***${url.slice(last)}`;
}

/** Whether `url` spells its scheme (`<scheme>://`), so a message may name the scheme it parsed to. */
export function spellsScheme(url: string): boolean {
  return SCHEME.test(url);
}
