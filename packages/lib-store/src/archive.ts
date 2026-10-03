// A record's archived source document: which one, and whether its bytes are
// really there. `blobPath` only builds a path; a path to bytes that are missing or
// no longer hash to their name is not the archive, and handing it out unchecked
// is how `ka open` would have shown a reader an altered file without comment.

import { OpenKaError, StoreError, assertValid, type Problem } from "@maschinenlesbar.org/openka-lib-errors";
import { SourceDocumentRoles, type SourceDocument } from "@maschinenlesbar.org/openka-lib-models";
import type { Store } from "./store.js";

/** A source-document role a record can hold — matched exactly, as stored. */
export const documentRoleProblem: Problem<string> = (value) =>
  (SourceDocumentRoles as readonly string[]).includes(value)
    ? undefined
    : `Allowed choices are ${SourceDocumentRoles.join(", ")}.`;

export interface ArchivedDocument {
  /** The source document chosen: the first with archived bytes (and the role, if given). */
  document: SourceDocument & { sha256: string };
  /** Where its bytes are, checked against their digest. */
  path: string;
}

/**
 * The archived bytes of one of a record's source documents, checked. Picks the
 * first document with archived bytes, or the first with `role`. Throws
 * `OpenKaValidationError` for a role no record can have, `OpenKaError` when there
 * is no such record or no such archived document, and `StoreError` — the corpus
 * is damaged — when the bytes are missing or no longer hash to their name.
 */
export function archivedDocument(store: Store, id: string, options: { role?: string } = {}): ArchivedDocument {
  const { role } = options;
  if (role !== undefined) assertValid("role", role, documentRoleProblem);
  const record = store.getRecord(id);
  if (record === undefined) throw new OpenKaError(`No record ${id} in ${store.root}`);
  const document = record.source_documents.find(
    (candidate) => candidate.sha256 !== undefined && (role === undefined || candidate.role === role),
  );
  if (document?.sha256 === undefined) {
    throw new OpenKaError(
      `Record ${id} has no archived document${role === undefined ? "" : ` with role ${role}`}. ` +
        "It was synced with --metadata-only, or the upstream served nothing.",
    );
  }
  const { sha256 } = document;
  if (!store.hasBlob(sha256)) {
    throw new StoreError(`The archived bytes for ${document.url} (${sha256}) are missing.`);
  }
  store.getBlob(sha256); // throws StoreError when the bytes no longer hash to their name
  return { document: { ...document, sha256 }, path: store.blobPath(sha256) };
}
