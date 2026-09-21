// Canonical JSON — the byte-level foundation of the reproducibility guarantee.
//
// "Same input → byte-identical output" only means something if two runs that
// produce the same *value* also produce the same *bytes*. JSON.stringify does not
// guarantee that: key order follows insertion order, which depends on the order a
// parser happened to fill an object in. So every record is serialised here with
// keys sorted lexicographically by UTF-16 code unit (the rule RFC 8785 uses),
// two-space indentation and a trailing newline.
//
// This is the form that is hashed, the form written to the corpus, and the form
// `ka get --format json` prints — so a record's file bytes, its hash input and its
// CLI output are all the same bytes, and `ka verify` can compare them directly.

/** Values canonical JSON accepts. `undefined` properties are dropped. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue | undefined };

function assertFiniteNumber(value: number): void {
  if (!Number.isFinite(value)) {
    throw new TypeError(`Cannot canonicalise non-finite number: ${String(value)}`);
  }
}

/**
 * Serialise `value` as canonical JSON, without a trailing newline.
 *
 * Object keys are sorted; `undefined` properties and `undefined` array entries
 * are dropped and nulled respectively, exactly as JSON.stringify would; functions
 * and symbols are rejected rather than silently skipped, because silently losing a
 * field would break the reproducibility contract quietly.
 */
export function canonicalJson(value: unknown, indent = 2): string {
  return write(value, indent, 0);
}

/** Canonical JSON plus the trailing newline used for on-disk records and stdout. */
export function canonicalJsonLine(value: unknown, indent = 2): string {
  return canonicalJson(value, indent) + "\n";
}

function write(value: unknown, indent: number, depth: number): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      assertFiniteNumber(value);
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new TypeError(`Cannot canonicalise value of type ${typeof value}`);
  }

  const pad = indent > 0 ? "\n" + " ".repeat(indent * (depth + 1)) : "";
  const closePad = indent > 0 ? "\n" + " ".repeat(indent * depth) : "";

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value.map((item) => (item === undefined ? "null" : write(item, indent, depth + 1)));
    return "[" + pad + items.join("," + pad) + closePad + "]";
  }

  const source = value as Record<string, unknown>;
  const keys = Object.keys(source)
    .filter((key) => source[key] !== undefined)
    .sort();
  if (keys.length === 0) return "{}";
  const entries = keys.map((key) => JSON.stringify(key) + (indent > 0 ? ": " : ":") + write(source[key], indent, depth + 1));
  return "{" + pad + entries.join("," + pad) + closePad + "}";
}
