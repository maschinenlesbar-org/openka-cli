# @maschinenlesbar.org/openka-lib-errors

> The error types the whole project throws.

Kept free of I/O so they are trivial to construct in a test and to `instanceof`-check
from a library consumer. Nothing here reads a file, opens a socket or formats for a
terminal — that is the CLI's job.

`AbstainError` is the one worth knowing about: it is not a failure. It is how the
tier stack says "I could not read this and I am not going to guess", which is the
behaviour the whole project exists to guarantee.

`OpenKaValidationError` is the other: the one class for an input a library function
refuses before it does anything — a blank option, an unknown value, a number out of
range. It extends `UsageError`, so it exits 2 from both CLIs, and its message reads
`Invalid <name>: <reason>`. The rules themselves are `Problem` functions
(`(value) => reason | undefined`), checked with `assertValid(name, value, problem)`
(`src/validate.ts`); a CLI value parser calls the same `Problem`, so a rule is
written once.

## Public surface

Everything is re-exported from the package root:

```
OpenKaError, OpenKaApiError, NetworkFailure, NetworkError, ParseError, StoreError, MissingCorpusError, UsageError,
OpenKaValidationError, AbstainError,
Problem, assertValid, isBlank, nonBlankProblem, BLANK_REASON
```

## Depends on

Nothing. This is a leaf of the dependency graph.

## Tests

`errors.test.ts` pins the hierarchy and `isRetryable`; `validate.test.ts` pins what
`assertValid` throws and the blank rule, because the CLIs print both as they are.
