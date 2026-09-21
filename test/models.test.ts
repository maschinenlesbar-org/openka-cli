// The schema, its canonical form and its validators — the trust guarantee's
// foundation, so these are the tests that must never be relaxed.

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { canonicalJson, canonicalJsonLine } from "../src/core/repro/canonical.js";
import { isSha256, sha256, sha256Canonical } from "../src/core/repro/hash.js";
import { makeRecordId, SCHEMA_VERSION } from "../src/core/models/schema.js";
import { isCalendarDate, validateRecord } from "../src/core/models/validate.js";
import { RECORD_JSON_SCHEMA } from "../src/core/models/json-schema.js";
import { isParliamentKey, parliamentByHerkunft, parliamentByKey, PARLIAMENTS } from "../src/core/models/parliaments.js";
import { extractorVersion, VERSION_ENV } from "../src/core/repro/version.js";
import { sampleRecord } from "./helpers.js";

describe("canonical JSON", () => {
  it("sorts keys at every level so equal values give equal bytes", () => {
    const a = canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } });
    const b = canonicalJson({ a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 });
    strictEqual(a, b);
    ok(a.indexOf('"a"') < a.indexOf('"b"'));
  });

  it("drops undefined properties rather than emitting null", () => {
    strictEqual(canonicalJson({ a: 1, b: undefined }), '{\n  "a": 1\n}');
  });

  it("renders empty containers compactly", () => {
    strictEqual(canonicalJson({ a: [], b: {} }), '{\n  "a": [],\n  "b": {}\n}');
  });

  it("refuses non-finite numbers instead of writing null", () => {
    let threw = false;
    try {
      canonicalJson({ a: Number.NaN });
    } catch {
      threw = true;
    }
    ok(threw);
  });

  it("ends a line form with exactly one newline", () => {
    strictEqual(canonicalJsonLine({ a: 1 }).endsWith("}\n"), true);
  });
});

describe("hashing", () => {
  it("hashes bytes and canonical values stably", () => {
    strictEqual(sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    strictEqual(sha256Canonical({ b: 1, a: 2 }), sha256Canonical({ a: 2, b: 1 }));
    ok(isSha256(sha256("abc")));
    strictEqual(isSha256("nope"), false);
  });
});

describe("record ids", () => {
  it("builds an id from parliament, period and the reference tail", () => {
    strictEqual(makeRecordId("berlin", 19, "19/10006"), "berlin-19-10006");
  });

  it("normalises the spacing a cover page adds to a Drucksachennummer", () => {
    strictEqual(makeRecordId("berlin", 19, "19 / 10 006"), makeRecordId("berlin", 19, "19/10006"));
  });

  it("keeps a reference with no slash intact", () => {
    strictEqual(makeRecordId("bund", 21, "7563"), "bund-21-7563");
  });
});

describe("parliaments", () => {
  it("covers the Bundestag and all 16 Länder", () => {
    strictEqual(PARLIAMENTS.length, 17);
    strictEqual(PARLIAMENTS.filter((parliament) => parliament.herkunft !== undefined).length, 16);
  });

  it("looks parliaments up by key and by Herkunft code", () => {
    strictEqual(parliamentByKey("berlin")?.herkunft, "BLN");
    strictEqual(parliamentByHerkunft("hh")?.key, "hamburg");
    strictEqual(parliamentByHerkunft("XX"), undefined);
    ok(isParliamentKey("sachsen-anhalt"));
    strictEqual(isParliamentKey("bavaria"), false);
  });
});

describe("calendar dates", () => {
  it("accepts real dates and rejects impossible ones", () => {
    ok(isCalendarDate("2024-02-29"));
    strictEqual(isCalendarDate("2023-02-29"), false);
    strictEqual(isCalendarDate("2024-13-01"), false);
    strictEqual(isCalendarDate("2024-3-1"), false);
  });
});

describe("record validation", () => {
  it("accepts a well-formed record", () => {
    deepStrictEqual(validateRecord(sampleRecord()), []);
  });

  it("rejects an id that does not match its own parts", () => {
    const issues = validateRecord(sampleRecord({ id: "berlin-19-99999" }));
    ok(issues.some((issue) => issue.path === "id"));
  });

  it("rejects an answer date before the submission date", () => {
    const issues = validateRecord(sampleRecord({ dates: { submitted: "2024-03-28", answered: "2024-03-01" } }));
    ok(issues.some((issue) => issue.path === "dates.answered"));
  });

  it("rejects a duplicate question number", () => {
    const issues = validateRecord(
      sampleRecord({ qa: [{ number: "1", answer: "a" }, { number: "1", answer: "b" }] }),
    );
    ok(issues.some((issue) => issue.path === "qa[1].number"));
  });

  it("refuses to call a record complete while it names abstentions", () => {
    const record = sampleRecord();
    record.extraction.abstained_fields = ["qa[0].answer"];
    const issues = validateRecord(record);
    ok(issues.some((issue) => issue.path === "extraction.parse_complete"));
    ok(issues.some((issue) => issue.path === "extraction.review_status"));
  });

  it("rejects a non-http source document URL", () => {
    const record = sampleRecord();
    record.source_documents = [{ role: "answer_pdf", url: "file:///etc/passwd", url_stable: true }];
    ok(validateRecord(record).some((issue) => issue.path === "source_documents[0].url"));
  });

  it("collects every issue rather than stopping at the first", () => {
    const issues = validateRecord({ schema_version: "0.9" });
    ok(issues.length > 3);
  });
});

describe("JSON Schema", () => {
  it("declares the same required top-level fields the model has", () => {
    const required = (RECORD_JSON_SCHEMA["required"] as string[]).slice().sort();
    const actual = Object.keys(sampleRecord())
      .filter((key) => key !== "full_text")
      .sort();
    deepStrictEqual(required, actual);
  });

  it("pins the schema version it describes", () => {
    const properties = RECORD_JSON_SCHEMA["properties"] as Record<string, { const?: string }>;
    strictEqual(properties["schema_version"]?.const, SCHEMA_VERSION);
  });

  it("closes every object so an unknown field is a schema error", () => {
    strictEqual(RECORD_JSON_SCHEMA["additionalProperties"], false);
  });
});

describe("extractor version", () => {
  it("prefers the environment stamp the factory sets", () => {
    strictEqual(extractorVersion({ [VERSION_ENV]: "sha:9f3c" }), "sha:9f3c");
  });

  it("falls back to the package version", () => {
    ok(extractorVersion({}).startsWith("pkg:"));
  });

  it("ignores a blank stamp rather than recording an empty provenance", () => {
    ok(extractorVersion({ [VERSION_ENV]: "   " }).startsWith("pkg:"));
  });
});
