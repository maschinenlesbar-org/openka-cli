// The CLI <-> library parity helper.
//
// One input, two doors: `run()` (or `runFactory()`) with injected deps, and the
// library function the CLI is meant to wrap. Both run on ONE recording transport
// and on corpora seeded the same way, so a test can assert they agree — both
// refuse the input and send nothing, or both do the same thing. A rule that lives
// only in a commander parser shows up here as two different outcomes.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStore } from "@maschinenlesbar.org/openka-lib-store";
import type { FetchEngine, HttpRequest, Transport } from "@maschinenlesbar.org/openka-lib-http";
import { testEngine } from "@maschinenlesbar.org/openka-lib-testing";
import { run } from "../src/run.js";
import { cliHarness } from "./harness.js";
import type { CliDeps } from "../src/io.js";

export interface CliOutcome {
  code: number;
  out: string;
  err: string;
  /** `METHOD url` for every request the CLI made. */
  requests: string[];
}

export type LibOutcome =
  | { ok: true; value: unknown; requests: string[] }
  | { ok: false; error: { name: string; message: string }; requests: string[] };

export interface LibContext {
  transport: Transport;
  /** An engine on the recording transport, with no pacing and no real sleeping. */
  engine: FetchEngine;
  /** The library side's own corpus, seeded like the CLI's. */
  corpus: string;
  store: FileStore;
}

export interface ParityOptions {
  /** The CLI's argv; a function receives the CLI side's corpus path. */
  argv: string[] | ((corpus: string) => string[]);
  /** The library call the CLI wraps. A synchronous throw is captured too. */
  lib: (context: LibContext) => unknown;
  /** `run` by default; pass `runFactory` for `ka-factory`. */
  runner?: (argv: string[], deps: CliDeps) => Promise<number>;
  /** Answers the requests both sides make. Unset, any request fails loudly. */
  responder?: Transport;
  /** Fills each side's corpus before its call. */
  seed?: (corpus: string) => void | Promise<void>;
  env?: NodeJS.ProcessEnv;
}

export interface ParityResult {
  cli: CliOutcome;
  lib: LibOutcome;
}

const describeRequest = (request: HttpRequest): string => `${request.method} ${request.url}`;

/** Run one input through the CLI and through the library; return both outcomes. */
export async function parity(options: ParityOptions): Promise<ParityResult> {
  const calls: HttpRequest[] = [];
  const respond: Transport =
    options.responder ??
    (async (request) => {
      throw new Error(`parity: unexpected request ${describeRequest(request)}`);
    });
  const transport: Transport = async (request) => {
    calls.push(request);
    return respond(request);
  };

  const harness = cliHarness({ transport, ...(options.env === undefined ? {} : { env: options.env }) });
  const libCorpus = mkdtempSync(join(tmpdir(), "openka-parity-"));
  try {
    await options.seed?.(harness.corpus);
    const argv = typeof options.argv === "function" ? options.argv(harness.corpus) : options.argv;
    const code = await (options.runner ?? run)(argv, harness.deps);
    const cli: CliOutcome = { code, out: harness.stdout(), err: harness.stderr(), requests: calls.map(describeRequest) };

    const before = calls.length;
    await options.seed?.(libCorpus);
    const libRequests = (): string[] => calls.slice(before).map(describeRequest);
    let lib: LibOutcome;
    try {
      const value = await options.lib({ transport, engine: testEngine(transport), corpus: libCorpus, store: new FileStore(libCorpus) });
      lib = { ok: true, value, requests: libRequests() };
    } catch (error) {
      const name = error instanceof Error ? error.constructor.name : typeof error;
      const message = error instanceof Error ? error.message : String(error);
      lib = { ok: false, error: { name, message }, requests: libRequests() };
    }
    return { cli, lib };
  } finally {
    harness.cleanup();
    rmSync(libCorpus, { recursive: true, force: true });
  }
}
