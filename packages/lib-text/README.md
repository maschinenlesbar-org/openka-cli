# @maschinenlesbar.org/openka-lib-text

> One implementation of text hygiene, with three intentions.

Control characters are stripped where upstream bytes become record text, and again
wherever upstream text is shown to a human.

There used to be three implementations of this: `stripControlCharacters` here,
`sanitizeForTerminal` in the CLI and `sanitizeServerText` in the fetch engine — the
last two character-for-character identical but for a trailing `.trim()`. None of
them said which threat it was defending against, so nobody could tell whether a
difference between them was deliberate. There is one now, and the options say what
each caller wants.

This package is part of the **extraction digest**: changing it changes what a
document turns into, so `npm run stamp` and a golden re-freeze are required.

## Public surface

Everything is re-exported from the package root:

```
ControlCharacterOptions, stripControlCharacters
```

## Depends on

Nothing. This is a leaf of the dependency graph.

## Tests

No tests of its own; covered through `lib-pdf`'s reader tests, which is where the behaviour actually matters.
