// Shared test helpers: an in-memory store, a scripted transport, a CLI harness and
// the paths to the committed fixtures.
//
// Everything here exists so a test can drive the real code end to end without a
// network, a subprocess or a clock — the two seams the architecture is built
// around (`Transport` and `CliDeps`) make that possible, and these helpers are what
// use them.

import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FileStore } from "../src/core/store/file-store.js";
import { FetchEngine, type EngineOptions } from "../src/core/http/engine.js";
import type { HttpRequest, HttpResponse, Transport } from "../src/core/http/http.js";
import type { CliDeps, CliIO } from "../src/cli/io.js";
import type { IndexShard } from "../src/core/store/fts.js";
import type { KaRecord } from "../src/core/models/schema.js";
import type { CatalogEntry, EmbeddingSet, SourceState, Store } from "../src/core/store/store.js";
import { sha256 } from "../src/core/repro/hash.js";
import { assertValidRecord } from "../src/core/models/validate.js";

/** Repository root, resolved from this file so tests work from any cwd. */
export const PROJECT_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

export const FIXTURES = join(PROJECT_ROOT, "fixtures");

export function fixture(...parts: string[]): string {
  return join(FIXTURES, ...parts);
}

export function readFixture(...parts: string[]): Buffer {
  return readFileSync(fixture(...parts));
}

export function readFixtureText(...parts: string[]): string {
  return readFileSync(fixture(...parts), "utf8");
}

// ------------------------------------------------------------- memory store

/** A `Store` that lives entirely in memory, for tests that never touch a disk. */
export class MemoryStore implements Store {
  readonly root = "/memory";
  private readonly blobs = new Map<string, Buffer>();
  private readonly records = new Map<string, Buffer>();
  private readonly rows = new Map<string, CatalogEntry>();
  private readonly shards = new Map<string, IndexShard>();
  private readonly states = new Map<string, SourceState>();
  private embeddings: EmbeddingSet | undefined;

  hasBlob(digest: string): boolean {
    return this.blobs.has(digest);
  }
  putBlob(data: Buffer): string {
    const digest = sha256(data);
    this.blobs.set(digest, Buffer.from(data));
    return digest;
  }
  getBlob(digest: string): Buffer {
    const blob = this.blobs.get(digest);
    if (blob === undefined) throw new Error(`No blob ${digest}`);
    return blob;
  }
  blobPath(digest: string): string {
    return `/memory/blobs/${digest}.bin`;
  }

  hasRecord(id: string): boolean {
    return this.records.has(id);
  }
  getRecordBytes(id: string): Buffer | undefined {
    return this.records.get(id);
  }
  getRecord(id: string): KaRecord | undefined {
    const bytes = this.records.get(id);
    return bytes === undefined ? undefined : (JSON.parse(bytes.toString("utf8")) as KaRecord);
  }
  putRecord(record: KaRecord): void {
    assertValidRecord(record);
    this.records.set(record.id, Buffer.from(JSON.stringify(record), "utf8"));
  }
  deleteRecord(id: string): void {
    this.records.delete(id);
  }
  recordIds(): string[] {
    return [...this.records.keys()].sort();
  }

  catalog(): CatalogEntry[] {
    return [...this.rows.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  }
  catalogEntry(id: string): CatalogEntry | undefined {
    return this.rows.get(id);
  }
  putCatalogEntry(entry: CatalogEntry): void {
    this.rows.set(entry.id, entry);
  }
  removeCatalogEntry(id: string): void {
    this.rows.delete(id);
  }

  loadShard(shard: string): IndexShard {
    return JSON.parse(JSON.stringify(this.shards.get(shard) ?? {})) as IndexShard;
  }
  saveShard(shard: string, data: IndexShard): void {
    if (Object.keys(data).length === 0) this.shards.delete(shard);
    else this.shards.set(shard, data);
  }
  shardNames(): string[] {
    return [...this.shards.keys()].sort();
  }

  getSourceState(source: string): SourceState {
    return this.states.get(source) ?? { source, http_cache: {} };
  }
  putSourceState(state: SourceState): void {
    this.states.set(state.source, state);
  }
  sourceStateKeys(): string[] {
    return [...this.states.keys()].sort();
  }

  private readonly artifacts = new Map<string, unknown>();
  loadArtifact<T>(name: string): T | undefined {
    return this.artifacts.get(name) as T | undefined;
  }
  saveArtifact(name: string, value: unknown): void {
    this.artifacts.set(name, JSON.parse(JSON.stringify(value)) as unknown);
  }

  loadEmbeddings(): EmbeddingSet | undefined {
    return this.embeddings;
  }
  saveEmbeddings(set: EmbeddingSet): void {
    this.embeddings = set;
  }
}

// ---------------------------------------------------------------- transport

export interface ScriptedRoute {
  /** Substring or RegExp the request URL must match. */
  match: string | RegExp;
  status?: number;
  headers?: Record<string, string>;
  body?: Buffer | string;
}

export interface ScriptedTransport {
  transport: Transport;
  /** Every request the code under test made, in order. */
  requests: HttpRequest[];
}

/**
 * A transport that answers from a fixed script. An unmatched URL throws rather
 * than returning a 404, so a test that accidentally reaches for the network fails
 * loudly instead of exercising an error path it did not mean to.
 */
export function scriptedTransport(routes: ScriptedRoute[]): ScriptedTransport {
  const requests: HttpRequest[] = [];
  const transport: Transport = async (request) => {
    requests.push(request);
    const route = routes.find((candidate) =>
      typeof candidate.match === "string" ? request.url.includes(candidate.match) : candidate.match.test(request.url),
    );
    if (route === undefined) throw new Error(`No scripted route for ${request.method} ${request.url}`);
    const body = route.body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(route.body) ? route.body : Buffer.from(route.body, "utf8");
    const response: HttpResponse = {
      status: route.status ?? 200,
      headers: route.headers ?? {},
      body,
    };
    return response;
  };
  return { transport, requests };
}

/** An engine with no rate limiting and no real sleeping, for fast tests. */
export function testEngine(transport: Transport, options: EngineOptions = {}): FetchEngine {
  return new FetchEngine({
    transport,
    minHostIntervalMs: 0,
    sleep: async () => undefined,
    ...options,
  });
}

// -------------------------------------------------------------------- CLI

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
export function sampleRecord(overrides: Partial<KaRecord> = {}): KaRecord {
  const base: KaRecord = {
    schema_version: "1.0",
    id: "berlin-19-12345",
    parliament: "berlin",
    document_type: "schriftliche_anfrage",
    reference: "19/12345",
    legislative_period: 19,
    title: "Zustand der Brückenbauwerke",
    askers: [{ name: "Erika Mustermann", party: "SPD", role: "MdA" }],
    answered_by: { ministry: "Senatsverwaltung für Umwelt und Verkehr" },
    dates: { submitted: "2024-03-01", answered: "2024-03-28" },
    qa: [{ number: "1", question: "Wie viele Brücken sind marode?", answer: "Vierzehn." }],
    markers: { classified: false, contains_tables: false, attachments_referenced: [] },
    full_text: "Frage 1:\nWie viele Brücken sind marode?\nAntwort zu 1:\nVierzehn.",
    source_documents: [
      {
        role: "combined_pdf",
        url: "https://example.invalid/19-12345.pdf",
        sha256: "0".repeat(64),
        retrieved_at: "2024-04-02T10:14:00Z",
        url_stable: true,
      },
    ],
    extraction: {
      tier: "text_layer",
      extractor_version: "test:1",
      model_artifacts: [],
      input_sha256: "1".repeat(64),
      reproducible: true,
      parse_complete: true,
      abstained_fields: [],
      review_status: "ok",
    },
  };
  return { ...base, ...overrides };
}
