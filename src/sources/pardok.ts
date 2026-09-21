// The `Parlamentsspiegel Export 1.0` XML format.
//
// This is worth its own module because it is not Berlin-specific: the DTD is the
// Landtag NRW's aggregation format that the Länder deliver to the Parlamentsspiegel
// in, and Berlin happens to publish its own feed of it as open data. Any parliament
// that publishes the same export becomes a `structured` source by registering the
// feed URL — no new parser.
//
// Shape of one record, as it actually appears in the Berlin feed:
//
//   <Vorgang>
//     <VID>V-351557</VID><VTyp>Anfrage</VTyp>
//     <Dokument>
//       <DHerk>BLN</DHerk><Wp>19</Wp><DokArt>Drs</DokArt>
//       <DokTyp>SchrAnfr</DokTyp><DokTypL>Schriftliche Anfrage</DokTypL>
//       <DokNr>19/10006</DokNr><DokDat>04.11.2021</DokDat>
//       <Titel>Wann kommen die Solaranlagen nach Pankow?</Titel>
//       <Urheber>Otto, Andreas (Grüne)</Urheber><LokURL>https://…pdf</LokURL>
//     </Dokument>
//     <Dokument><DokTyp>a</DokTyp><DokTypL>Antwort</DokTypL>…</Dokument>
//   </Vorgang>

import type { AnsweredBy, DocumentType } from "../core/models/schema.js";
import { parseGermanDate, parseUrheber } from "../core/extract/metadata.js";
import { childText, childrenNamed, streamElements, type XmlNode } from "./xml.js";
import type { DocRef, DocRefDocument } from "./base.js";

/** `DokTyp` codes that mark the question document of an Anfrage. */
export const QUESTION_DOC_TYPES: Record<string, DocumentType> = {
  SchrAnfr: "schriftliche_anfrage",
  KlAnfr: "kleine_anfrage",
  GrAnfr: "grosse_anfrage",
  KlAnfrage: "kleine_anfrage",
};

/** `DokTyp` codes that mark the government's answer. `a` is the code Berlin uses. */
export const ANSWER_DOC_TYPES = new Set(["a", "Antw", "Antwort"]);

export interface PardokOptions {
  /** Only accept documents from this Herkunft code (`BLN`), when given. */
  herkunft?: string;
  /** Only these document types; defaults to every question type above. */
  documentTypes?: readonly DocumentType[];
}

/**
 * Convert one `<Vorgang>` into a DocRef, or `undefined` when it is not an Anfrage,
 * is a deletion marker, or lacks the fields a record needs to have an identity.
 */
export function pardokVorgangToRef(vorgang: XmlNode, options: PardokOptions = {}): DocRef | undefined {
  // `<VFunktion>delete</VFunktion>` retracts a previously exported Vorgang. The
  // feed carries both the retraction and the replacement, so honouring it matters.
  if (childText(vorgang, "VFunktion")?.toLowerCase() === "delete") return undefined;

  const documents = childrenNamed(vorgang, "Dokument");
  let question: XmlNode | undefined;
  let answer: XmlNode | undefined;
  for (const document of documents) {
    const type = childText(document, "DokTyp");
    if (type === undefined) continue;
    if (question === undefined && QUESTION_DOC_TYPES[type] !== undefined) question = document;
    else if (answer === undefined && ANSWER_DOC_TYPES.has(type)) answer = document;
  }
  if (question === undefined) return undefined;

  const herkunft = childText(question, "DHerk");
  if (options.herkunft !== undefined && herkunft !== options.herkunft) return undefined;

  const documentType = QUESTION_DOC_TYPES[childText(question, "DokTyp") as string] as DocumentType;
  if (options.documentTypes !== undefined && !options.documentTypes.includes(documentType)) return undefined;

  const reference = childText(question, "DokNr") ?? childText(question, "NrInTyp");
  const period = Number(childText(question, "Wp"));
  if (reference === undefined || !Number.isInteger(period) || period < 1) return undefined;

  const submitted = toIso(childText(question, "DokDat"));
  const answered = toIso(answer !== undefined ? childText(answer, "DokDat") : undefined);

  const answeredBy: AnsweredBy = {};
  const ministry = answer !== undefined ? childText(answer, "Urheber") : undefined;
  if (ministry !== undefined) answeredBy.ministry = ministry;

  const refDocuments = collectDocuments(question, answer);

  const ref: DocRef = {
    key: childText(vorgang, "VID") ?? childText(vorgang, "VNr") ?? reference,
    reference,
    legislative_period: period,
    title: childText(question, "Titel") ?? "",
    documentType,
    askers: parseUrheber(childText(question, "Urheber") ?? ""),
    answered_by: answeredBy,
    dates: {},
    documents: refDocuments,
  };
  if (submitted !== undefined) ref.dates.submitted = submitted;
  if (answered !== undefined) ref.dates.answered = answered;
  return ref;
}

/**
 * Berlin publishes question and answer as one PDF, so both `<Dokument>` elements
 * carry the same `LokURL`. Emitting it once as a `combined_pdf` keeps the record
 * from claiming two source documents where one exists.
 */
function collectDocuments(question: XmlNode, answer: XmlNode | undefined): DocRefDocument[] {
  const questionUrl = childText(question, "LokURL");
  const answerUrl = answer !== undefined ? childText(answer, "LokURL") : undefined;
  const documents: DocRefDocument[] = [];
  if (questionUrl !== undefined && questionUrl === answerUrl) {
    documents.push({ role: "combined_pdf", url: questionUrl, urlStable: true });
    return documents;
  }
  if (questionUrl !== undefined) documents.push({ role: "question_pdf", url: questionUrl, urlStable: true });
  if (answerUrl !== undefined) documents.push({ role: "answer_pdf", url: answerUrl, urlStable: true });
  return documents;
}

function toIso(value: string | undefined): string | undefined {
  return value === undefined ? undefined : parseGermanDate(value);
}

/** Walk a whole export document, yielding one DocRef per usable `<Vorgang>`. */
export function* parsePardokExport(xml: string, options: PardokOptions = {}): Generator<DocRef> {
  for (const vorgang of streamElements(xml, "Vorgang")) {
    const ref = pardokVorgangToRef(vorgang, options);
    if (ref !== undefined) yield ref;
  }
}
