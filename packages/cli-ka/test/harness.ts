// The CLI test harness.
//
// It lives here rather than in `lib-testing` because it builds a `CliDeps`, and the
// shared helpers must not depend on the CLI: the CLI's own tests use those helpers,
// and the dependency cannot point both ways.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliDeps, CliIO } from "../src/io.js";
import type { Transport } from "@maschinenlesbar.org/openka-lib-http";
import { FileStore } from "@maschinenlesbar.org/openka-lib-store";
import { FetchEngine } from "@maschinenlesbar.org/openka-lib-http";

export interface CliHarness {
  deps: CliDeps;
  out: string[];
  err: string[];
  files: Map<string, Buffer>;
  /** Everything written to stdout, joined. */
  stdout(): string;
  stderr(): string;
  cleanup(): void;
  corpus: string;
}

/**
 * A CLI harness with a real temporary corpus on disk (so the FileStore is exercised
 * for real), captured output, a fixed clock, and a transport the caller scripts.
 */
export function cliHarness(options: { transport?: Transport; env?: NodeJS.ProcessEnv; now?: Date } = {}): CliHarness {
  const corpus = mkdtempSync(join(tmpdir(), "openka-test-"));
  const out: string[] = [];
  const err: string[] = [];
  const files = new Map<string, Buffer>();
  const io: CliIO = {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    writeFile: (path, data) => void files.set(path, data),
  };
  const fixedNow = options.now ?? new Date("2026-01-02T03:04:05Z");
  const deps: CliDeps = {
    io,
    createStore: (root) => new FileStore(root),
    createEngine: (engineOptions) =>
      new FetchEngine({
        ...engineOptions,
        minHostIntervalMs: 0,
        sleep: async () => undefined,
        ...(options.transport === undefined ? {} : { transport: options.transport }),
      }),
    env: options.env ?? {},
    now: () => fixedNow,
  };
  return {
    deps,
    out,
    err,
    files,
    corpus,
    stdout: () => out.join("\n"),
    stderr: () => err.join("\n"),
    cleanup: () => rmSync(corpus, { recursive: true, force: true }),
  };
}

/** A minimal valid record, for tests that need one without building it by hand. */
