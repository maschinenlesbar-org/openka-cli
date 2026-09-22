// robots.txt, parsed and applied (RFC 9309).
//
// This project respects robots.txt by default — CONCEPT.md §7 — and two Länder
// disallow their documentation servers outright. The rule is enforced here rather
// than hard-coded in a connector for one reason: a Land can change its mind. The
// file is fetched and read at run time, so a `Disallow: /` that is lifted stops
// blocking us the same day, and one that appears starts blocking us the same day.
//
// The operator can override it. That decision belongs to whoever runs the sync and
// knows what they are doing it for, not to this library, and it is never silent:
// the override is a flag they typed and a warning on every record it produced.

/** One `User-agent` group's rules, in the order they were written. */
export interface RobotsGroup {
  agents: string[];
  rules: { allow: boolean; path: string }[];
  crawlDelaySeconds?: number;
}

export interface RobotsRules {
  groups: RobotsGroup[];
  /** True when the file said nothing at all — no groups, or it was not served. */
  empty: boolean;
}

/** Nothing is disallowed: what a 404 on /robots.txt means. */
export const NO_RULES: RobotsRules = { groups: [], empty: true };

/**
 * Parse a robots.txt.
 *
 * Consecutive `User-agent` lines share one group, which is what makes a file like
 * Sachsen-Anhalt's — two separate `User-agent: *` groups with different rules —
 * two groups rather than one. RFC 9309 says the rules of all groups matching an
 * agent apply together, and `isAllowed` merges them for that reason.
 */
export function parseRobots(text: string): RobotsRules {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | undefined;
  let lastWasAgent = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (line === "") continue;
    const at = line.indexOf(":");
    if (at < 0) continue;
    const field = line.slice(0, at).trim().toLowerCase();
    const value = line.slice(at + 1).trim();

    if (field === "user-agent") {
      if (current === undefined || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (current === undefined) continue;
    if (field === "allow" || field === "disallow") {
      // "Disallow:" with an empty value allows everything, and is not a rule.
      if (field === "disallow" && value === "") continue;
      current.rules.push({ allow: field === "allow", path: value });
    } else if (field === "crawl-delay") {
      const seconds = Number(value.replace(",", "."));
      if (Number.isFinite(seconds) && seconds > 0) current.crawlDelaySeconds = seconds;
    }
  }
  return { groups, empty: groups.length === 0 };
}

/** Every group that applies to this agent: its own, else the `*` groups. */
function groupsFor(rules: RobotsRules, userAgent: string): RobotsGroup[] {
  const agent = userAgent.toLowerCase();
  const named = rules.groups.filter((group) => group.agents.some((a) => a !== "*" && agent.includes(a)));
  if (named.length > 0) return named;
  return rules.groups.filter((group) => group.agents.includes("*"));
}

/** A rule's specificity, for the longest-match rule of RFC 9309 §2.2.2. */
function matchLength(pattern: string, path: string): number | undefined {
  // `*` matches any run, `$` anchors the end.
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const expression = body
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  const regex = new RegExp(`^${expression}${anchored ? "$" : ""}`);
  return regex.test(path) ? body.length : undefined;
}

/**
 * Whether a path may be fetched.
 *
 * Longest match wins, and `Allow` wins a tie — the behaviour every major crawler
 * implements and the one RFC 9309 specifies.
 */
export function isAllowed(rules: RobotsRules, userAgent: string, path: string): boolean {
  const applicable = groupsFor(rules, userAgent);
  let best: { allow: boolean; length: number } | undefined;
  for (const group of applicable) {
    for (const rule of group.rules) {
      const length = matchLength(rule.path, path);
      if (length === undefined) continue;
      if (best === undefined || length > best.length || (length === best.length && rule.allow)) {
        best = { allow: rule.allow, length };
      }
    }
  }
  return best?.allow ?? true;
}

/** The `Crawl-delay` this agent should honour, in milliseconds. */
export function crawlDelayMs(rules: RobotsRules, userAgent: string): number | undefined {
  for (const group of groupsFor(rules, userAgent)) {
    if (group.crawlDelaySeconds !== undefined) return Math.round(group.crawlDelaySeconds * 1000);
  }
  return undefined;
}
