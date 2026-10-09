// Credentials kept apart from the corpus: `ka config set bund.api-key` (issue #18).
//
// The DIP key could only come from `--api-key`, which puts it into shell history and
// `ps`, or from `DIP_API_KEY`, which every shell, cron job and launcher has to export —
// people ended up writing it into wrapper scripts. It now has a home of its own:
//
//   $XDG_CONFIG_HOME/openka/credentials   (else ~/.config/openka/credentials)
//
// one JSON object of name → value, mode 0600 in a directory of mode 0700, replaced
// atomically, and never inside a corpus, so neither `ka export` nor a copy of the
// corpus can carry it along. An OS keychain is not used (yet): on servers, under cron,
// systemd and in containers it is usually locked or missing, and this file is what
// such a setup would fall back to anyway.

import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";
import { StoreError, UsageError, isBlank, type Problem } from "@maschinenlesbar.org/openka-lib-errors";

/** A credential's name: `<source>.<what>`, like `bund.api-key`. */
const NAME = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/;

/** Why `name` cannot name a credential, or undefined. */
export const credentialNameProblem: Problem<string> = (name) =>
  NAME.test(name) ? undefined : "Not a credential name: expected <source>.<what>, like bund.api-key.";

/**
 * Why `value` cannot be stored as a credential, or undefined: blank, or holding
 * whitespace or control characters inside — a key is one token, and a stray newline
 * from a paste would be sent as part of a header.
 */
export const credentialValueProblem: Problem<string> = (value) => {
  if (isBlank(value)) return "The value is empty.";
  if (/[\s\u0000-\u001f\u007f-\u009f]/.test(value)) return "The value holds whitespace or control characters; a key is one token.";
  return undefined;
};

/**
 * Where the credentials file is: `$XDG_CONFIG_HOME/openka/credentials`, else
 * `$HOME/.config/openka/credentials` — `HOME` from `env` first, so a caller's
 * environment decides, and only then the system's home directory.
 */
export function resolveCredentialsPath(env: NodeJS.ProcessEnv): string {
  const xdg = env["XDG_CONFIG_HOME"];
  if (xdg !== undefined && !isBlank(xdg) && isAbsolute(xdg)) return join(xdg, "openka", "credentials");
  const home = env["HOME"] !== undefined && !isBlank(env["HOME"]) ? env["HOME"] : homedir();
  return join(home, ".config", "openka", "credentials");
}

/** Whether `path` lies inside `dir` (or is it). */
function inside(path: string, dir: string): boolean {
  const rel = relative(resolve(dir), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * `abcd…wxyz`: enough to tell two keys apart, never enough to use one. A value too
 * short for that shows nothing of itself, not even its length.
 */
export function maskCredential(value: string): string {
  return value.length >= 12 ? `${value.slice(0, 4)}…${value.slice(-4)}` : "****";
}

/**
 * The credentials file. Reading it checks what ssh checks of a private key: a regular
 * file, owned by this user, readable by nobody else — anything else is a `StoreError`
 * naming the fix, rather than a key quietly used from a file others can read.
 */
export class CredentialStore {
  readonly path: string;

  constructor(path: string) {
    this.path = resolve(path);
  }

  /** The store at `resolveCredentialsPath(env)`. */
  static fromEnv(env: NodeJS.ProcessEnv): CredentialStore {
    return new CredentialStore(resolveCredentialsPath(env));
  }

  /** Refuse a credentials file inside the corpus: `ka export` or a copy of it would carry the key along. */
  assertOutside(corpusRoot: string): void {
    if (inside(this.path, corpusRoot)) {
      throw new UsageError(`The credentials file ${this.path} would be inside the corpus ${resolve(corpusRoot)}; set XDG_CONFIG_HOME to a directory outside it.`);
    }
  }

  get(name: string): string | undefined {
    return this.read()[name];
  }

  /** Every stored name, sorted. */
  names(): string[] {
    return Object.keys(this.read()).sort();
  }

  set(name: string, value: string): void {
    const nameReason = credentialNameProblem(name);
    if (nameReason !== undefined) throw new UsageError(nameReason);
    const valueReason = credentialValueProblem(value);
    if (valueReason !== undefined) throw new UsageError(valueReason);
    this.write({ ...this.read(), [name]: value });
  }

  /** Remove `name`; false when it was not stored. The file goes when nothing is left in it. */
  unset(name: string): boolean {
    const all = this.read();
    if (!(name in all)) return false;
    delete all[name];
    if (Object.keys(all).length === 0) {
      try {
        rmSync(this.path, { force: true });
      } catch (err) {
        throw this.writeError(err);
      }
      return true;
    }
    this.write(all);
    return true;
  }

  private read(): Record<string, string> {
    // lstat, not exists: a link — dangling or not — is refused, not taken for "no file".
    let stats;
    try {
      stats = lstatSync(this.path);
    } catch (err) {
      if ((err as { code?: unknown }).code === "ENOENT") return {};
      throw new StoreError(`Could not read the credentials file ${this.path}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    if (!stats.isFile()) throw new StoreError(`${this.path} is not a regular file; it cannot be the credentials file.`);
    if (process.platform !== "win32") {
      if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
        throw new StoreError(`The credentials file ${this.path} belongs to another user; it is not read.`);
      }
      if ((stats.mode & 0o077) !== 0) {
        throw new StoreError(
          `The credentials file ${this.path} can be read by others (mode ${(stats.mode & 0o777).toString(8)}); ` +
            `it is not used until only you can: chmod 600 ${this.path}`,
        );
      }
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.path, "utf8"));
    } catch (err) {
      throw new StoreError(`The credentials file ${this.path} is not valid JSON; fix it, or remove it and set the values again.`, { cause: err });
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || !Object.values(parsed).every((value) => typeof value === "string")) {
      throw new StoreError(`The credentials file ${this.path} is not an object of names and strings.`);
    }
    return { ...(parsed as Record<string, string>) };
  }

  /**
   * Replace the file atomically: a temporary file beside it, created with mode 0600
   * and exclusively, renamed over it. A crash leaves the old file or the new one,
   * never half of either, and at no moment is the key in a file others can read.
   */
  private write(all: Record<string, string>): void {
    const dir = dirname(this.path);
    const temporary = `${this.path}.tmp-${process.pid}`;
    const sorted = Object.fromEntries(Object.entries(all).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    try {
      // Inside the try: an unwritable config location (EACCES on mkdir or chmod) is
      // reported like any other write failure, naming the file.
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (process.platform !== "win32" && (statSync(dir).mode & 0o077) !== 0) chmodSync(dir, 0o700);
      // Left by a run of the same pid that crashed between the two steps.
      rmSync(temporary, { force: true });
      writeFileSync(temporary, JSON.stringify(sorted, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      renameSync(temporary, this.path);
    } catch (err) {
      rmSync(temporary, { force: true });
      throw this.writeError(err);
    }
  }

  /** "Could not write the credentials file <path>: <reason>", the cause kept. */
  private writeError(err: unknown): StoreError {
    return new StoreError(`Could not write the credentials file ${this.path}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}
