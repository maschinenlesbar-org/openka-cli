// The guardrail that makes "no generative model on the line" a checkable property
// rather than a promise in a document.
//
// CONCEPT.md §8 names this as the hardest rule to enforce. The check is blunt on
// purpose: the line — every workspace package except the factory — may not import
// an LLM client, may not reach a model provider's host, and may not import anything
// from the factory. There is no longer a file outside `packages/` to special-case:
// the published entry point is `packages/openka-cli` like everything else. Since the split into
// workspaces the last of those is also a package boundary: nothing on the line
// declares `openka-cli-ka-factory` as a dependency, so a violation fails to resolve
// long before it fails the lint. The lint stays because a boundary that is only
// enforced by a manifest is one `npm install` away from being gone.
//
// A violation fails the build. It is not a proof (a
// determined author can always call `fetch` on a computed URL) but it catches the
// realistic failure, which is someone reaching for a model to paper over a hard
// document and nobody noticing in review.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** The one package that is not on the line: build-time tooling. */
export const FACTORY_PACKAGE = "cli-ka-factory";

/**
 * Every package whose sources must stay deterministic — that is, all of them except
 * the factory. Discovered rather than listed: a new connector is on the line from
 * the moment it exists, without anyone remembering to add it here.
 */
export function lineRoots(projectRoot: string): string[] {
  const packages = join(projectRoot, "packages");
  let names: string[];
  try {
    names = readdirSync(packages).sort();
  } catch {
    return ["src"];
  }
  return names
    .filter((name) => name !== FACTORY_PACKAGE)
    .map((name) => `packages/${name}/src`)
    .filter((dir) => {
      try {
        return statSync(join(projectRoot, dir)).isDirectory();
      } catch {
        return false;
      }
    });
}

/**
 * Package names that mean "a generative model is being called". Perceptual OCR is
 * deliberately absent: it is the one sanctioned model on the line (CONCEPT.md §6)
 * and it is narrow, pinned, hashed and required to abstain.
 */
export const FORBIDDEN_MODULES = [
  "@anthropic-ai/sdk",
  "@anthropic-ai/claude-code",
  "@anthropic-ai/bedrock-sdk",
  "openai",
  "@azure/openai",
  "@google/generative-ai",
  "@google-cloud/aiplatform",
  "@mistralai/mistralai",
  "cohere-ai",
  "replicate",
  "ollama",
  "langchain",
  "@langchain/core",
  "llamaindex",
  "ai",
] as const;

/** Hosts that only ever appear in code that calls a model. */
export const FORBIDDEN_HOSTS = [
  "api.anthropic.com",
  "api.openai.com",
  "generativelanguage.googleapis.com",
  "api.cohere.ai",
  "api.mistral.ai",
  "api.replicate.com",
  "api.together.xyz",
  "openrouter.ai",
] as const;

export interface LintViolation {
  file: string;
  line: number;
  rule: "forbidden-module" | "forbidden-host" | "factory-import";
  detail: string;
}

function walk(root: string, base: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const entry of entries.sort()) {
    const full = join(root, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) walk(full, base, out);
    else if (entry.endsWith(".ts")) out.push(relative(base, full));
  }
}

/** Every file on the line, as paths relative to the project root. */
export function lineFiles(projectRoot: string): string[] {
  const files: string[] = [];
  for (const root of lineRoots(projectRoot)) walk(join(projectRoot, root), projectRoot, files);
  return files.sort();
}

/**
 * Every form in which a module specifier can enter a file: a static `import`/`export
 * … from`, a side-effect `import "x"`, a dynamic `import("x")` and `require("x")`.
 *
 * The clause between the keyword and `from` is `[^;'"]*?` — deliberately including
 * newlines. Matching it line by line is how this check came to miss
 * `import {\n  OpenAI,\n} from "openai"`, which is the prevailing style in this
 * codebase, so the guardrail was enforcing nothing against the ordinary way of
 * writing an import. Excluding `;` and both quote characters keeps the lazy match
 * from running past the end of the statement it started in.
 */
const IMPORT_PATTERN =
  /\b(?:import|export)\b\s*(?:[^;'"]*?\s)?from\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;

/** 1-based line number of a character offset, for reporting a whole-file match. */
function lineAt(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) if (source[i] === "\n") line++;
  return line;
}

/**
 * Check one file's text. Comments are stripped first so that *writing about* the
 * rule — as several modules in this project do — does not trip it.
 */
export function lintSource(file: string, source: string): LintViolation[] {
  const violations: LintViolation[] = [];
  const stripped = stripComments(source);

  // Imports are matched over the whole file, because a static import may be
  // spread across several lines; the offset is mapped back to a line for the report.
  // `matchAll` copies the pattern, so the module-level /g regex cannot carry a
  // `lastIndex` from one file's scan into the next.
  for (const match of stripped.matchAll(IMPORT_PATTERN)) {
    const specifier = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (specifier === undefined) continue;
    const line = lineAt(stripped, match.index);
    const bare = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
    if ((FORBIDDEN_MODULES as readonly string[]).includes(bare ?? "")) {
      violations.push({
        file,
        line,
        rule: "forbidden-module",
        detail: `imports "${specifier}" — a generative model client may not be reachable from the line`,
      });
    }
    if (/(^|\/)factory(\/|$)/.test(specifier) || specifier.endsWith(`-${FACTORY_PACKAGE}`)) {
      violations.push({
        file,
        line,
        rule: "factory-import",
        detail: `imports "${specifier}" — factory tooling is build-time only and must not be a runtime dependency`,
      });
    }
  }

  stripped.split("\n").forEach((line, index) => {
    for (const host of FORBIDDEN_HOSTS) {
      if (line.includes(host)) {
        violations.push({ file, line: index + 1, rule: "forbidden-host", detail: `mentions ${host}` });
      }
    }
  });

  return violations.sort((a, b) => a.line - b.line || (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0));
}

/** Remove line and block comments, preserving line numbering. */
export function stripComments(source: string): string {
  let out = "";
  let i = 0;
  let inString: string | undefined;
  while (i < source.length) {
    const ch = source[i] as string;
    const next = source[i + 1];
    if (inString !== undefined) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (ch === inString) inString = undefined;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

export interface LintReport {
  filesChecked: number;
  violations: LintViolation[];
}

/** Lint the whole line. */
export function lintLine(projectRoot: string): LintReport {
  const files = lineFiles(projectRoot);
  const violations: LintViolation[] = [];
  for (const file of files) {
    let source: string;
    try {
      source = readFileSync(join(projectRoot, file), "utf8");
    } catch {
      continue;
    }
    violations.push(...lintSource(file, source));
  }
  return { filesChecked: files.length, violations };
}

/** A command a workflow runs that this repository has to be able to satisfy. */
export interface WorkflowCommand {
  workflow: string;
  line: number;
  /** `script` for `npm run <name>`, `path` for `node <file>`. */
  kind: "script" | "path";
  value: string;
  /**
   * The step's `working-directory`, relative to the repository root, or `""`.
   *
   * It decides which `package.json` a script has to be in: the website's build
   * steps run in `site/`, where the scripts are the site's own, not the
   * workspace's.
   */
  directory: string;
}

/**
 * Every `npm run <script>` and `node <path>` the CI workflows invoke.
 *
 * This exists because the workspace refactor broke CI twice in a row and nothing
 * caught it: the workflows still ran `node dist/src/factory/cli/index.js lint` and
 * read the version out of the root `package.json`, both of which moved. A stale
 * path in a workflow is invisible until a push fails, and it fails after the build
 * and the tests have already passed — the slowest possible feedback.
 */
export function workflowCommands(projectRoot: string): WorkflowCommand[] {
  const directory = join(projectRoot, ".github", "workflows");
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"));
  } catch {
    return [];
  }
  const found: WorkflowCommand[] = [];
  for (const name of names.sort()) {
    const lines = readFileSync(join(directory, name), "utf8").split(/\r?\n/);
    // `working-directory` applies to the step it is written in, so it is tracked
    // by indentation: a key at or below the step's indent ends its scope.
    let cwd = "";
    let cwdIndent = Number.POSITIVE_INFINITY;
    lines.forEach((text, index) => {
      const indent = text.length - text.trimStart().length;
      const here = /^\s*working-directory:\s*(\S+)\s*$/.exec(text);
      if (here !== null) {
        cwd = (here[1] as string).replace(/^\.\//, "");
        cwdIndent = indent;
      } else if (/^\s*- /.test(text) && indent <= cwdIndent) {
        cwd = "";
        cwdIndent = Number.POSITIVE_INFINITY;
      }
      const script = /\bnpm run ([a-z][\w:-]*)/.exec(text);
      if (script !== null) {
        found.push({ workflow: name, line: index + 1, kind: "script", value: script[1] as string, directory: cwd });
      }
      // `node <path>`, but not `node -p`, `node -e` or a `node-version:` key.
      const path = /\bnode\s+((?:packages|dist|tools|scripts)\/[\w./-]+)/.exec(text);
      if (path !== null) {
        found.push({ workflow: name, line: index + 1, kind: "path", value: path[1] as string, directory: cwd });
      }
    });
  }
  return found;
}


/** The Node versions CI builds against, lowest first. */
export function ciNodeVersions(projectRoot: string): number[] {
  let text: string;
  try {
    text = readFileSync(join(projectRoot, ".github", "workflows", "ci.yml"), "utf8");
  } catch {
    return [];
  }
  const matrix = /node-version:\s*\[([^\]]*)\]/.exec(text);
  if (matrix === null) return [];
  return (matrix[1] as string)
    .split(",")
    .map((entry) => Number.parseInt(entry.trim(), 10))
    .filter((major) => Number.isInteger(major))
    .sort((a, b) => a - b);
}

/** The major version `engines.node` requires, from a `>=N` range. */
export function enginesFloor(projectRoot: string): number | undefined {
  const manifest = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")) as {
    engines?: { node?: string };
  };
  const match = /(\d+)/.exec(manifest.engines?.node ?? "");
  return match === null ? undefined : Number.parseInt(match[1] as string, 10);
}
