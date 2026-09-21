// The guardrail that makes "no generative model on the line" a checkable property
// rather than a promise in a document.
//
// CONCEPT.md §8 names this as the hardest rule to enforce. The check is blunt on
// purpose: the line — `src/core`, `src/sources`, `src/cli`, `src/index.ts` — may not
// import an LLM client, may not reach a model provider's host, and may not import
// anything from `src/factory`. A violation fails the build. It is not a proof (a
// determined author can always call `fetch` on a computed URL) but it catches the
// realistic failure, which is someone reaching for a model to paper over a hard
// document and nobody noticing in review.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** Directories that make up the line. Everything here must stay deterministic. */
export const LINE_ROOTS = ["src/core", "src/sources", "src/cli"] as const;

/** Single files that are part of the line. */
export const LINE_FILES = ["src/index.ts"] as const;

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
  for (const root of LINE_ROOTS) walk(join(projectRoot, root), projectRoot, files);
  for (const file of LINE_FILES) {
    try {
      if (statSync(join(projectRoot, file)).isFile()) files.push(file);
    } catch {
      /* the file may not exist in a partial checkout */
    }
  }
  return files.sort();
}

const IMPORT_PATTERN = /(?:^|\s)(?:import|export)[^;\n]*?from\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;

/**
 * Check one file's text. Comments are stripped first so that *writing about* the
 * rule — as several modules in this project do — does not trip it.
 */
export function lintSource(file: string, source: string): LintViolation[] {
  const violations: LintViolation[] = [];
  const stripped = stripComments(source);
  const lines = stripped.split("\n");

  lines.forEach((line, index) => {
    IMPORT_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = IMPORT_PATTERN.exec(line)) !== null) {
      const specifier = match[1] ?? match[2] ?? match[3];
      if (specifier === undefined) continue;
      const bare = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
      if ((FORBIDDEN_MODULES as readonly string[]).includes(bare ?? "")) {
        violations.push({
          file,
          line: index + 1,
          rule: "forbidden-module",
          detail: `imports "${specifier}" — a generative model client may not be reachable from the line`,
        });
      }
      if (/(^|\/)factory(\/|$)/.test(specifier)) {
        violations.push({
          file,
          line: index + 1,
          rule: "factory-import",
          detail: `imports "${specifier}" — factory tooling is build-time only and must not be a runtime dependency`,
        });
      }
    }
    for (const host of FORBIDDEN_HOSTS) {
      if (line.includes(host)) {
        violations.push({ file, line: index + 1, rule: "forbidden-host", detail: `mentions ${host}` });
      }
    }
  });

  return violations;
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
