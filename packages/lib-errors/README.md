# @maschinenlesbar.org/openka-lib-errors

> The error types the whole project throws.

Kept free of I/O so they are trivial to construct in a test and to `instanceof`-check
from a library consumer. Nothing here reads a file, opens a socket or formats for a
terminal — that is the CLI's job.

`AbstainError` is the one worth knowing about: it is not a failure. It is how the
tier stack says "I could not read this and I am not going to guess", which is the
behaviour the whole project exists to guarantee.

## Public surface

Everything is re-exported from the package root:

```
OpenKaError, OpenKaApiError, NetworkError, ParseError, StoreError, UsageError, AbstainError
```

## Depends on

Nothing. This is a leaf of the dependency graph.

## Tests

No tests of its own — the types are exercised everywhere else, and there is no behaviour here to pin.
