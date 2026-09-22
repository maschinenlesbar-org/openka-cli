// robots.txt, against the two files that actually decide something here.

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { crawlDelayMs, isAllowed, parseRobots } from "../src/index.js";
import { fixtures } from "@maschinenlesbar.org/openka-lib-testing";

const { readFixtureText } = fixtures(import.meta.url);
const AGENT = "openka-cli";

describe("the two files that block us", () => {
  it("reads Brandenburg's as a whole-site disallow", () => {
    const rules = parseRobots(readFixtureText("www.parlamentsdokumentation.brandenburg.de.robots.txt"));
    strictEqual(isAllowed(rules, AGENT, "/cgi-bin/pardok-cache.pl?id=100"), false);
    strictEqual(isAllowed(rules, AGENT, "/"), false);
  });

  it("reads Sachsen-Anhalt's malformed file the conservative way", () => {
    // It has two separate `User-agent: *` groups — the first disallowing only
    // `/files/`, the last disallowing everything. RFC 9309 applies the rules of
    // every matching group together, so the whole site is disallowed. A parser that
    // stopped at the first group would see a site that is almost entirely open,
    // which is the reading this must not take by accident.
    const rules = parseRobots(readFixtureText("padoka.landtag.sachsen-anhalt.de.robots.txt"));
    strictEqual(rules.groups.filter((group) => group.agents.includes("*")).length, 2);
    strictEqual(isAllowed(rules, AGENT, "/starweb/PADOKA/servlet.starweb"), false);
    strictEqual(isAllowed(rules, AGENT, "/files/anything.pdf"), false);
  });
});

describe("the rules themselves", () => {
  it("allows everything when the file is absent or empty", () => {
    ok(parseRobots("").empty);
    strictEqual(isAllowed(parseRobots(""), AGENT, "/anything"), true);
  });

  it("treats an empty Disallow as permission, not prohibition", () => {
    strictEqual(isAllowed(parseRobots("User-agent: *\nDisallow:"), AGENT, "/x"), true);
  });

  it("lets the longest match win, and Allow win a tie", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /docs/\nAllow: /docs/public/");
    strictEqual(isAllowed(rules, AGENT, "/docs/secret.pdf"), false);
    strictEqual(isAllowed(rules, AGENT, "/docs/public/a.pdf"), true);
    const tie = parseRobots("User-agent: *\nDisallow: /a\nAllow: /a");
    strictEqual(isAllowed(tie, AGENT, "/a"), true);
  });

  it("honours wildcards and an end anchor", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /*.pdf$");
    strictEqual(isAllowed(rules, AGENT, "/x/y.pdf"), false);
    strictEqual(isAllowed(rules, AGENT, "/x/y.pdf?v=1"), true);
  });

  it("prefers a group naming this agent over the wildcard group", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /\n\nUser-agent: openka-cli\nAllow: /\nCrawl-delay: 5");
    strictEqual(isAllowed(rules, AGENT, "/anything"), true);
    strictEqual(crawlDelayMs(rules, AGENT), 5000);
    // ...and another client still sees the wildcard group.
    strictEqual(isAllowed(rules, "some-other-bot", "/anything"), false);
  });

  it("groups consecutive User-agent lines together", () => {
    const rules = parseRobots("User-agent: a\nUser-agent: b\nDisallow: /x");
    strictEqual(rules.groups.length, 1);
    deepStrictEqual(rules.groups[0]?.agents, ["a", "b"]);
  });
});
