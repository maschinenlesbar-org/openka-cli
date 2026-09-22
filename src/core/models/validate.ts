// Deterministic structural validation of a canonical record.
//
// This is a plain hand-written validator rather than a schema library: the line
// must stay dependency-free, and the checks the project actually needs are
// semantic (a date ordering, an id that matches its parts, an abstained field path
// that points at a field that is really absent) rather than purely structural.
//
// Validation never repairs. It reports; the caller decides whether to abstain.

import {
  DocumentTypes,
  ReviewStatuses,
  SCHEMA_VERSION,
  SourceDocumentRoles,
  Tiers,
  makeRecordId,
  type KaRecord,
} from "./schema.js";
import { isParliamentKey } from "./parliaments.js";
import { RECORD_JSON_SCHEMA } from "./json-schema.js";
import { isSha256 } from "../repro/hash.js";

export interface ValidationIssue {
  /** Dotted path into the record, e.g. `qa[2].number`. */
  path: string;
  message: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** True for a calendar-valid `YYYY-MM-DD` date (rejects 2024-02-31). */
export function isCalendarDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  if (m < 1 || m > 12 || d < 1) return false;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= daysInMonth;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(
  issues: ValidationIssue[],
  value: unknown,
  path: string,
  { allowEmpty = false } = {},
): value is string {
  if (typeof value !== "string") {
    issues.push({ path, message: "expected a string" });
    return false;
  }
  if (!allowEmpty && value.trim() === "") {
    issues.push({ path, message: "expected a non-empty string" });
    return false;
  }
  return true;
}

function requireEnum(
  issues: ValidationIssue[],
  value: unknown,
  allowed: readonly string[],
  path: string,
): void {
  if (typeof value !== "string" || !allowed.includes(value)) {
    issues.push({ path, message: `expected one of: ${allowed.join(", ")}` });
  }
}

function requireBoolean(issues: ValidationIssue[], value: unknown, path: string): void {
  if (typeof value !== "boolean") issues.push({ path, message: "expected a boolean" });
}

function requireArray(issues: ValidationIssue[], value: unknown, path: string): value is unknown[] {
  if (!Array.isArray(value)) {
    issues.push({ path, message: "expected an array" });
    return false;
  }
  return true;
}

function checkDate(issues: ValidationIssue[], value: unknown, path: string): void {
  if (value === undefined) return;
  if (typeof value !== "string" || !isCalendarDate(value)) {
    issues.push({ path, message: "expected a calendar date as YYYY-MM-DD" });
  }
}

/**
 * Validate a record. Returns every issue found (never throws, never stops at the
 * first problem) so `ka review` can show a complete picture of one document.
 */
export function validateRecord(value: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isObject(value)) return [{ path: "", message: "expected an object" }];
  const record = value as unknown as KaRecord;

  if (record.schema_version !== SCHEMA_VERSION) {
    issues.push({ path: "schema_version", message: `expected "${SCHEMA_VERSION}"` });
  }
  requireString(issues, record.id, "id");
  if (typeof record.parliament !== "string" || !isParliamentKey(record.parliament)) {
    issues.push({ path: "parliament", message: "unknown parliament key" });
  }
  requireEnum(issues, record.document_type, DocumentTypes, "document_type");
  requireString(issues, record.reference, "reference");
  if (!Number.isInteger(record.legislative_period) || record.legislative_period < 1) {
    issues.push({ path: "legislative_period", message: "expected a positive integer" });
  }
  requireString(issues, record.title, "title", { allowEmpty: true });

  if (
    typeof record.id === "string" &&
    typeof record.parliament === "string" &&
    typeof record.reference === "string" &&
    Number.isInteger(record.legislative_period) &&
    record.id !== makeRecordId(record.parliament, record.legislative_period, record.reference)
  ) {
    issues.push({ path: "id", message: "id does not match parliament/period/reference" });
  }

  if (requireArray(issues, record.askers, "askers")) {
    record.askers.forEach((asker, i) => {
      if (!isObject(asker)) {
        issues.push({ path: `askers[${i}]`, message: "expected an object" });
        return;
      }
      requireString(issues, asker["name"], `askers[${i}].name`);
      for (const key of ["party", "role"] as const) {
        if (asker[key] !== undefined) requireString(issues, asker[key], `askers[${i}].${key}`);
      }
    });
  }

  if (!isObject(record.answered_by)) {
    issues.push({ path: "answered_by", message: "expected an object" });
  }

  if (!isObject(record.dates)) {
    issues.push({ path: "dates", message: "expected an object" });
  } else {
    checkDate(issues, record.dates.submitted, "dates.submitted");
    checkDate(issues, record.dates.answered, "dates.answered");
    const { submitted, answered } = record.dates;
    if (
      typeof submitted === "string" &&
      typeof answered === "string" &&
      isCalendarDate(submitted) &&
      isCalendarDate(answered) &&
      answered < submitted
    ) {
      issues.push({ path: "dates.answered", message: "answer date precedes the submission date" });
    }
  }

  if (requireArray(issues, record.qa, "qa")) {
    const seen = new Set<string>();
    record.qa.forEach((pair, i) => {
      if (!isObject(pair)) {
        issues.push({ path: `qa[${i}]`, message: "expected an object" });
        return;
      }
      if (requireString(issues, pair["number"], `qa[${i}].number`)) {
        const number = pair["number"] as string;
        if (seen.has(number)) issues.push({ path: `qa[${i}].number`, message: `duplicate question number "${number}"` });
        seen.add(number);
      }
      for (const key of ["question", "answer"] as const) {
        if (pair[key] !== undefined) requireString(issues, pair[key], `qa[${i}].${key}`, { allowEmpty: true });
      }
    });
  }

  if (!isObject(record.markers)) {
    issues.push({ path: "markers", message: "expected an object" });
  } else {
    requireBoolean(issues, record.markers.classified, "markers.classified");
    requireBoolean(issues, record.markers.contains_tables, "markers.contains_tables");
    requireArray(issues, record.markers.attachments_referenced, "markers.attachments_referenced");
  }

  if (record.full_text !== undefined) requireString(issues, record.full_text, "full_text", { allowEmpty: true });

  if (requireArray(issues, record.source_documents, "source_documents")) {
    record.source_documents.forEach((doc, i) => {
      if (!isObject(doc)) {
        issues.push({ path: `source_documents[${i}]`, message: "expected an object" });
        return;
      }
      requireEnum(issues, doc["role"], SourceDocumentRoles, `source_documents[${i}].role`);
      if (requireString(issues, doc["url"], `source_documents[${i}].url`)) {
        let url: URL | undefined;
        try {
          url = new URL(doc["url"] as string);
        } catch {
          issues.push({ path: `source_documents[${i}].url`, message: "expected an absolute URL" });
        }
        if (url && url.protocol !== "http:" && url.protocol !== "https:") {
          issues.push({ path: `source_documents[${i}].url`, message: "only http(s) URLs are accepted" });
        }
      }
      const digest = doc["sha256"];
      if (digest !== undefined && (typeof digest !== "string" || !isSha256(digest))) {
        issues.push({ path: `source_documents[${i}].sha256`, message: "expected a lowercase hex sha256" });
      }
      const retrieved = doc["retrieved_at"];
      if (retrieved !== undefined && (typeof retrieved !== "string" || !ISO_INSTANT.test(retrieved))) {
        issues.push({
          path: `source_documents[${i}].retrieved_at`,
          message: "expected an ISO-8601 UTC instant (YYYY-MM-DDThh:mm:ssZ)",
        });
      }
      requireBoolean(issues, doc["url_stable"], `source_documents[${i}].url_stable`);
    });
  }

  validateExtraction(issues, record);
  checkNoUnknownProperties(issues, value, RECORD_JSON_SCHEMA as unknown, "");
  return issues;
}

/**
 * Reject a property the published JSON Schema does not declare.
 *
 * The schema says `additionalProperties: false` at every level; the hand-written
 * validator checked no such thing, so the store accepted — and wrote to disk —
 * records that fail the contract `ka schema` publishes. The sharpest case was
 * `extraction.confidence`: a confidence score is the one field CONCEPT.md rules
 * out by name, because abstention replaces it, and nothing stopped one being
 * stored.
 *
 * The allowed keys are read out of the schema rather than restated here, so the
 * two cannot drift apart.
 */
function checkNoUnknownProperties(issues: ValidationIssue[], value: unknown, schema: unknown, path: string): void {
  if (!isObject(schema)) return;
  const properties = schema["properties"];
  if (schema["type"] === "object" && isObject(properties)) {
    if (!isObject(value)) return;
    if (schema["additionalProperties"] === false) {
      for (const key of Object.keys(value)) {
        if (key in properties) continue;
        issues.push({
          path: path === "" ? key : `${path}.${key}`,
          message: "unknown property — the published JSON Schema does not declare it",
        });
      }
    }
    for (const [key, child] of Object.entries(properties)) {
      if (value[key] !== undefined) checkNoUnknownProperties(issues, value[key], child, path === "" ? key : `${path}.${key}`);
    }
    return;
  }
  if (schema["type"] === "array" && Array.isArray(value)) {
    for (const [i, item] of value.entries()) checkNoUnknownProperties(issues, item, schema["items"], `${path}[${i}]`);
  }
}

function validateExtraction(issues: ValidationIssue[], record: KaRecord): void {
  const extraction = record.extraction as unknown;
  if (!isObject(extraction)) {
    issues.push({ path: "extraction", message: "expected an object" });
    return;
  }
  requireEnum(issues, extraction["tier"], Tiers, "extraction.tier");
  requireString(issues, extraction["extractor_version"], "extraction.extractor_version");
  const input = extraction["input_sha256"];
  if (typeof input !== "string" || !isSha256(input)) {
    issues.push({ path: "extraction.input_sha256", message: "expected a lowercase hex sha256" });
  }
  requireBoolean(issues, extraction["reproducible"], "extraction.reproducible");
  requireBoolean(issues, extraction["parse_complete"], "extraction.parse_complete");
  requireEnum(issues, extraction["review_status"], ReviewStatuses, "extraction.review_status");

  if (requireArray(issues, extraction["model_artifacts"], "extraction.model_artifacts")) {
    (extraction["model_artifacts"] as unknown[]).forEach((artifact, i) => {
      if (!isObject(artifact)) {
        issues.push({ path: `extraction.model_artifacts[${i}]`, message: "expected an object" });
        return;
      }
      requireString(issues, artifact["name"], `extraction.model_artifacts[${i}].name`);
      requireString(issues, artifact["version"], `extraction.model_artifacts[${i}].version`);
      const weights = artifact["weights_sha256"];
      if (weights !== undefined && (typeof weights !== "string" || !isSha256(weights))) {
        issues.push({
          path: `extraction.model_artifacts[${i}].weights_sha256`,
          message: "expected a lowercase hex sha256",
        });
      }
    });
  }

  if (requireArray(issues, extraction["abstained_fields"], "extraction.abstained_fields")) {
    const abstained = extraction["abstained_fields"] as unknown[];
    abstained.forEach((field, i) => requireString(issues, field, `extraction.abstained_fields[${i}]`));
    // A record claiming completeness while naming abstentions is self-contradictory;
    // that inconsistency would quietly hide a hole from `ka review`.
    if (abstained.length > 0 && extraction["parse_complete"] === true) {
      issues.push({
        path: "extraction.parse_complete",
        message: "cannot be true while abstained_fields is non-empty",
      });
    }
    if (abstained.length > 0 && extraction["review_status"] === "ok") {
      issues.push({
        path: "extraction.review_status",
        message: 'cannot be "ok" while abstained_fields is non-empty',
      });
    }
  }
}

/** Throw on the first validation issue. Used where a caller cannot continue. */
export function assertValidRecord(value: unknown): asserts value is KaRecord {
  const issues = validateRecord(value);
  if (issues.length > 0) {
    const [first] = issues;
    throw new Error(
      `Invalid record: ${first?.path || "<root>"}: ${first?.message}` +
        (issues.length > 1 ? ` (and ${issues.length - 1} more)` : ""),
    );
  }
}
