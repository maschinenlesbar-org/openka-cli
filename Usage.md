# Usage

Every command, with the options that matter. `ka --help` and `ka <command> --help`
are authoritative; this is the narrative version.

## Global options

| Option | Meaning |
|--------|---------|
| `--corpus <dir>` | where the corpus lives (default: `$OPENKA_CORPUS`, else `$XDG_DATA_HOME/openka`, else `~/.local/share/openka`); the flag and the variable are taken as given, spaces included |
| `--timeout <ms>` | timeout per request attempt; a timed-out request is retried once |
| `--user-agent <ua>` | override the identifying User-Agent; not blank, no control characters, nothing above U+00FF |
| `--max-retries <n>` | retries (0–10) for a transient 429/503 or a dropped connection; a response over `--max-response-bytes` is never retried |
| `--max-response-bytes <n>` | hard cap on one response body (at least 1024) |
| `--min-host-interval <ms>` | minimum delay between two requests to one host (0–60000) |
| `--max-redirects <n>` | redirects to follow (0–10); `0` surfaces a 3xx as an error |
| `--compact` | compact JSON output |
| `--quiet` | suppress progress on stderr |

## `ka sync`

```bash
ka sync --source berlin --since 2024-01-01 --until 2024-06-30 --limit 200
ka sync --source nordrhein-westfalen --since 2025-03-01 --until 2025-04-30
ka sync --source bund --api-key "$DIP_KEY" --period 21
ka sync --source parlamentsspiegel --since 2025-01-01   # all 16 Länder, metadata + links
ka sync --source berlin --metadata-only                 # no downloads; qa abstains
ka sync --source berlin --force                         # re-extract unchanged inputs
ka sync --source berlin --ocr tesseract --ocr-version 5.3.4 --ocr-traineddata /usr/share/tessdata/deu.traineddata
```

Idempotent: a second run over an unchanged window costs one conditional request and
stores nothing. `--force` bypasses both the feed's `ETag` and the per-record check.

**Dates mean when the Anfrage was asked.** `--since`/`--until` here, and `--year`
and `--from`/`--to` on `search` and `export`, all filter on the question's date, not
the answer's — a question asked in June is often answered in August, and the other
reading makes a window exclude exactly what it was meant to include. An `--until`
before `--since` is a usage error (exit 2), not an empty sync.

## `ka search`

```bash
ka search "brücken zustand"              # all terms must match
ka search '"marode brücke"'              # an exact phrase
ka search "brücke -sanierung"            # exclude a term
ka search --parliament berlin --year 2024 --party SPD
ka search --needs-review --parliament bund
ka search --like berlin-19-10006         # needs `ka-factory embed` first
ka search "radwege" --snippet --json
```

Filters are repeatable (`--parliament berlin --parliament bund`). An empty query
lists everything that passes the filters. With `--like`, `total` in the JSON counts
every similar record, not just the page `--limit` shows, as it does for keyword search.

## `ka get` / `ka show` / `ka open`

```bash
ka get berlin-19-10006 --format json     # canonical JSON — the stored bytes
ka get berlin-19-10006 --format jsonld   # schema.org + an openka: namespace
ka get berlin-19-10006 --format csv
ka get berlin-19-10006 --format md -o anfrage.md
ka show berlin-19-10006                  # rendered for reading
open "$(ka open berlin-19-10006)"        # the archived PDF
```

`ka open` prints a path rather than launching a program, and only after checking the
bytes there. `--role` is one of `question_pdf`, `answer_pdf`, `combined_pdf`,
`metadata`; another value is a usage error (exit 2). Archived bytes that are missing
or no longer hash to their name are a corpus problem (exit 3).

## `ka verify`

```bash
ka verify berlin-19-10006        # one record
ka verify --limit 100            # a sample
ka verify --all --json           # everything, machine-readable
```

Re-runs the extraction from the archived bytes and asserts the canonical output is
byte-identical. Exits non-zero if any record does not reproduce. A record that cannot
be read is reported as a `FAIL` and the rest are still checked; the exit code is then
3, the corpus-problem code. The JSON report counts those rows as `unreadable`, and
marks each with `"unreadable": true`.

## `ka review`

```bash
ka review                                     # the abstention queue, worst first
ka review --source berlin --limit 50
ka review --mark-verified berlin-19-10041     # a person checked it against the PDF
```

Marking a record verified does **not** fill its holes; it records that someone
looked. `ka verify` knows this and does not treat it as a mismatch. A verified record
leaves the queue, but `ka search --needs-review` still finds it: that filter selects
records with abstained fields, verified or not.

## `ka export` / `ka feed`

```bash
ka export --format csv --out corpus.csv
ka export --format jsonl --parliament berlin --year 2024
ka feed --party GRÜNE --limit 50 --out gruene.atom
ka feed --query "brücken" --title "Brücken-Anfragen"
```

`export` writes every match — by id, or the most relevant first with `--query` — and
`feed` picks its `--limit` newest entries from the whole selection. A catalog row whose
record file is gone is named on stderr and left out; `ka reindex` rebuilds the catalog.
A `--query` with nothing searchable in it (`"???"`, `"a"`) is a usage error here as in
`ka search`, rather than a selection of every record.

`-o, --out <file>` (on `get`, `export` and `feed`) writes to a file; `-o -` is stdout.
An existing file is not replaced unless `--force` is given.

## `ka sources` / `ka stats` / `ka schema` / `ka reindex`

```bash
ka sources list            # every parliament, its adapter status, its last sync
ka sources show berlin     # what is specific about one source
ka stats                   # how much of the corpus is parse-complete
ka schema                  # the JSON Schema of a record
ka reindex                 # rebuild the index from the stored records
```

`ka reindex` rebuilds the catalog and the search index without reading the old ones,
so it repairs a corrupt catalog. A record that cannot be read is named on stderr and
left out of the index, and the command exits 3.

## `ka-factory`

```bash
ka-factory lint                                   # no generative model on the line
ka-factory goldens list
ka-factory goldens add berlin-19-10041 --note "sub-items and a date at line start"
ka-factory goldens verify                         # the regression gate
ka-factory health --save-baseline                 # into the corpus: health-baseline.json
ka-factory drift                                  # classified, with a repair suggestion
ka-factory answers niedersachsen --period 19 --from 7900 --to 8115 --merge
ka-factory embed                                  # frozen vectors for `ka search --like`
ka-factory embed --from vectors.jsonl --model bge-m3 --model-sha256 <hex>
```

`goldens add` without `--dir` files the golden in its source's connector package
(`packages/connector-<source>/fixtures/`), the layout `goldens list` and
`goldens verify` read; the source is the record's parliament unless `--source` says
otherwise.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | success (including `--help` and `--version`) |
| 1 | an error: an upstream failure, a failed verification, a missing record |
| 2 | a usage error (a rejected option value, a malformed record id, an unknown command) |
| 3 | the corpus is missing or unreadable (a `--corpus` that does not exist included) |
| 4 | the upstream returned 404 |
