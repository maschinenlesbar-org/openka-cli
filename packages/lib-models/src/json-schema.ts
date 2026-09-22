// JSON Schema for the canonical record, for consumers outside TypeScript.
//
// The TypeScript types in `schema.ts` remain the source of truth. This document is
// written by hand against them and pinned by `test/json-schema.test.ts`, which
// compares the schema's required-property lists against a real record so the two
// cannot drift apart unnoticed. `ka schema` prints it.

import { DocumentTypes, ReviewStatuses, SCHEMA_VERSION, SourceDocumentRoles, Tiers } from "./schema.js";
import { ParliamentKeys } from "./parliaments.js";

const SHA256 = { type: "string", pattern: "^[0-9a-f]{64}$" } as const;

/** The JSON Schema (draft 2020-12) describing a canonical OpenKA record. */
export const RECORD_JSON_SCHEMA: Record<string, unknown> = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: `https://maschinenlesbar-org.github.io/openka-cli/schema/${SCHEMA_VERSION}/record.json`,
  title: "OpenKA record",
  description:
    "One parliamentary Kleine Anfrage (or its per-parliament equivalent) together with the government's answer, in the standardized OpenKA format.",
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version",
    "id",
    "parliament",
    "document_type",
    "reference",
    "legislative_period",
    "title",
    "askers",
    "answered_by",
    "dates",
    "qa",
    "markers",
    "source_documents",
    "extraction",
  ],
  properties: {
    schema_version: { type: "string", const: SCHEMA_VERSION },
    id: { type: "string", description: "<parliament>-<period>-<reference tail>" },
    parliament: { type: "string", enum: [...ParliamentKeys] },
    document_type: { type: "string", enum: [...DocumentTypes] },
    reference: { type: "string", description: "Drucksachennummer exactly as printed" },
    legislative_period: { type: "integer", minimum: 1 },
    title: { type: "string" },
    askers: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name"],
        properties: {
          name: { type: "string" },
          party: { type: "string" },
          role: { type: "string" },
        },
      },
    },
    answered_by: {
      type: "object",
      additionalProperties: false,
      properties: { ministry: { type: "string" }, signatory: { type: "string" } },
    },
    dates: {
      type: "object",
      additionalProperties: false,
      properties: {
        submitted: { type: "string", format: "date" },
        answered: { type: "string", format: "date" },
      },
    },
    qa: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["number"],
        properties: {
          number: { type: "string" },
          question: { type: "string" },
          answer: { type: "string" },
        },
      },
    },
    markers: {
      type: "object",
      additionalProperties: false,
      required: ["classified", "contains_tables", "attachments_referenced"],
      properties: {
        classified: { type: "boolean" },
        contains_tables: { type: "boolean" },
        attachments_referenced: { type: "array", items: { type: "string" } },
      },
    },
    full_text: { type: "string" },
    source_documents: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["role", "url", "url_stable"],
        properties: {
          role: { type: "string", enum: [...SourceDocumentRoles] },
          url: { type: "string", format: "uri" },
          sha256: SHA256,
          retrieved_at: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$" },
          url_stable: { type: "boolean" },
        },
      },
    },
    extraction: {
      type: "object",
      additionalProperties: false,
      description: "How to reproduce this record — not how confident a model felt.",
      required: [
        "tier",
        "extractor_version",
        "model_artifacts",
        "input_sha256",
        "reproducible",
        "parse_complete",
        "abstained_fields",
        "review_status",
      ],
      properties: {
        tier: { type: "string", enum: [...Tiers] },
        extractor_version: { type: "string" },
        model_artifacts: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name", "version"],
            properties: { name: { type: "string" }, version: { type: "string" }, weights_sha256: SHA256 },
          },
        },
        input_sha256: SHA256,
        reproducible: { type: "boolean" },
        parse_complete: { type: "boolean" },
        abstained_fields: { type: "array", items: { type: "string" } },
        review_status: { type: "string", enum: [...ReviewStatuses] },
      },
    },
  },
};
