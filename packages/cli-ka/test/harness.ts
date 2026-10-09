// The CLI test harness.
//
// It lives here rather than in `lib-testing` because it builds a `CliDeps`, and the
// shared helpers must not depend on the CLI: the CLI's own tests use those helpers,
// and the dependency cannot point both ways.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliDeps, CliIO } from "../src/io.js";
import type { EngineOptions, Transport } from "@maschinenlesbar.org/openka-lib-http";
import { FileStore, type VolumeProbe } from "@maschinenlesbar.org/openka-lib-store";
import { FetchEngine } from "@maschinenlesbar.org/openka-lib-http";

export interface CliHarness {
  deps: CliDeps;
  out: string[];
  err: string[];
  files: Map<string, Buffer>;
  /** Everything written to stdout, joined. */
  stdout(): string;
  /** Everything written to stderr, joined, each record's timestamp taken off (`untimed`). */
  stderr(): string;
  cleanup(): void;
  corpus: string;
  /** `XDG_CONFIG_HOME` for this harness: the credentials file is `<config>/openka/credentials`. */
  config: string;
}

/**
 * A CLI harness with a real temporary corpus on disk (so the FileStore is exercised
 * for real), captured output, a fixed clock, and a transport the caller scripts.
 */
export function cliHarness(
  options: {
    transport?: Transport;
    env?: NodeJS.ProcessEnv;
    now?: Date;
    /**
     * The engine's clock and sleep, for a test that watches its pacing. Given, the
     * engine keeps the CLI's own interval; unset, it has none and never sleeps.
     */
    pacing?: Pick<EngineOptions, "now" | "sleep">;
    /** What the corpus is stored on. Unset, a local disk with 500 GB free — never the machine's own. */
    volumes?: VolumeProbe;
  } = {},
): CliHarness {
  const corpus = mkdtempSync(join(tmpdir(), "openka-test-"));
  // A config directory of its own, so no test reads or writes the user's credentials.
  const config = mkdtempSync(join(tmpdir(), "openka-config-"));
  const out: string[] = [];
  const err: string[] = [];
  const files = new Map<string, Buffer>();
  const io: CliIO = {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    // Like the real one: an existing file is only replaced when asked to.
    writeFile: (path, data, writeOptions) => {
      if (writeOptions?.overwrite !== true && files.has(path)) {
        throw Object.assign(new Error(`EEXIST: file already exists, open '${path}'`), { code: "EEXIST" });
      }
      files.set(path, data);
    },
    appendFile: (path, text) => {
      files.set(path, Buffer.concat([files.get(path) ?? Buffer.alloc(0), Buffer.from(text, "utf8")]));
    },
  };
  const fixedNow = options.now ?? new Date("2026-01-02T03:04:05Z");
  const deps: CliDeps = {
    io,
    createStore: (root, storeOptions) => new FileStore(root, storeOptions),
    openStore: (root, storeOptions) => FileStore.open(root, storeOptions),
    createEngine: (engineOptions) =>
      new FetchEngine({
        ...engineOptions,
        // No pacing and no real sleeping, unless the test watches the pacing:
        // then the engine keeps the interval the CLI asked for.
        ...(options.pacing ?? { minHostIntervalMs: 0, sleep: async () => undefined }),
        ...(options.transport === undefined ? {} : { transport: options.transport }),
      }),
    env: { XDG_CONFIG_HOME: config, ...options.env },
    now: () => fixedNow,
    volumes: options.volumes ?? roomyVolumes,
  };
  return {
    deps,
    out,
    err,
    files,
    corpus,
    stdout: () => out.join("\n"),
    stderr: () => untimed(err.join("\n")),
    cleanup: () => {
      rmSync(corpus, { recursive: true, force: true });
      rmSync(config, { recursive: true, force: true });
    },
    config,
  };
}

/**
 * stderr with each text record's timestamp taken off: `ERROR [ka.cli] …`. The format
 * itself — timestamp, level, topic — is the log tests' (`log.test.ts`); the other tests
 * check what was said, at which level and under which topic.
 */
export function untimed(text: string): string {
  return text.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /gm, "");
}

/** A local disk with room to spare: what every test that is not about volumes runs on. */
export const roomyVolumes: VolumeProbe = {
  space: () => ({ free: 500e9, total: 1e12 }),
  filesystem: () => ({ name: "apfs", kind: "local" }),
};

/** A minimal valid record, for tests that need one without building it by hand. */
