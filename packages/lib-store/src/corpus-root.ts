// Where a corpus lives when a caller names a path, sets the environment, or says
// nothing. One resolution for every door: the `ka` flag, `OPENKA_CORPUS`, and a
// library caller. A path is used exactly as given — never trimmed — because the
// flag and `FileStore` never trimmed it: trimming only the environment variable
// made `"corpus "` name one directory through `--corpus` and another through
// `OPENKA_CORPUS`, and `ka sync` would write into the one nobody named.

import { homedir } from "node:os";
import { resolve } from "node:path";
import { assertValid, isBlank, nonBlankProblem } from "@maschinenlesbar.org/openka-lib-errors";

/** Environment variable naming the corpus directory. */
export const CORPUS_ENV = "OPENKA_CORPUS";

export interface CorpusRootOptions {
  /** A path the caller named (`ka --corpus`); wins over the environment. */
  root?: string;
  /** The environment to read `OPENKA_CORPUS` and `XDG_DATA_HOME` from. */
  env: NodeJS.ProcessEnv;
}

/**
 * The corpus directory, absolute: `root` if given, else `$OPENKA_CORPUS`, else
 * `$XDG_DATA_HOME/openka`, else `~/.local/share/openka`. Every path is resolved as
 * given, untrimmed. An environment variable that is empty or only whitespace counts
 * as unset — the shell's `OPENKA_CORPUS= ka …`; a blank `root` is refused with
 * `OpenKaValidationError`, since a caller who names a path means one.
 */
export function resolveCorpusRoot(options: CorpusRootOptions): string {
  const { root, env } = options;
  assertValid("root", root, nonBlankProblem);
  if (root !== undefined) return resolve(root);
  const fromEnv = env[CORPUS_ENV];
  if (fromEnv !== undefined && !isBlank(fromEnv)) return resolve(fromEnv);
  const xdg = env["XDG_DATA_HOME"];
  if (xdg !== undefined && !isBlank(xdg)) return resolve(xdg, "openka");
  return resolve(homedir(), ".local", "share", "openka");
}
