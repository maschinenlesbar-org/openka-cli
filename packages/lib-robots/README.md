# @maschinenlesbar.org/openka-lib-robots

> robots.txt, parsed and applied (RFC 9309).

This project respects robots.txt by default — CONCEPT.md §7 — and two Länder disallow
their documentation servers outright.

The rule is enforced from the **live file** rather than hard-coded in a connector,
for one reason: a Land can change its mind. A `Disallow: /` that is lifted stops
blocking us the same day, and one that appears starts being honoured the same day. A
server with no robots.txt allows everything, which is what a 404 there means.

Correctness details that decide real cases here:

- **Consecutive `User-agent` lines share a group**, so a file with two *separate*
  `User-agent: *` sections is two groups — and RFC 9309 applies the rules of every
  matching group together. That is exactly Sachsen-Anhalt's file: the first group
  disallows `/files/`, the last disallows `/`. A parser that stopped at the first
  match would read that site as almost entirely open. It is not.
- **Longest match wins, and `Allow` wins a tie**, per §2.2.2.
- **`Disallow:` with an empty value is permission**, not prohibition.
- `*` and `$` are supported.
- A group naming this client beats the `*` group.

The operator can override the result. That decision belongs to whoever runs the sync
and knows what they are doing it for — see `--ignore-robots` — and it is never
silent: it is a flag they typed and a warning on every record it produced.

## Public surface

Everything is re-exported from the package root:

```
RobotsGroup, RobotsRules, NO_RULES, parseRobots, isAllowed, crawlDelayMs
```

## Depends on

Nothing. This is a leaf of the dependency graph.

## Tests

`test/robots.test.ts` — run with:

```bash
npm test -w @maschinenlesbar.org/openka-lib-robots
```

## Fixtures
