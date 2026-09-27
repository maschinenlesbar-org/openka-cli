// What a page repeats is not what the page says.
//
// Every parliament prints a running header on each page ("Drucksache 19 / 12365
// Bayerischer Landtag 19. Wahlperiode Seite 4 / 6"), most print a page number at
// the foot, and several close the paper with an imprint. The PDF reader returns all
// of it as text, and once the pages are joined into one stream for segmentation
// those lines land in the middle of whatever answer runs across the page break.
// Measured on 999 AfD Anfragen from ten parliaments (2026-09-27), 1,028 QA pairs
// carried a page header inside the answer — in records that reported themselves
// complete, because nothing about a header looks like a missing field.
//
// So the lines are removed before segmentation, while the page boundaries are still
// known. `full_text` keeps them: it is the document as printed, and a reader
// checking an answer against the PDF should find the same text there.
//
// Every pattern below is a template observed at a page edge in that corpus, and it
// is only tried at a page edge. A number is only a page number when it is *this*
// page's number, so the last figure of a table that happens to end a page stays.

import { PAGE_SEPARATOR } from "@maschinenlesbar.org/openka-lib-pdf";

/** How many lines at each end of a page are candidates for a running line. */
const EDGE_LINES = 3;

/**
 * Lower-case words a running header may contain. A header is a name plate —
 * "Landtag von Baden-Württemberg Drucksache 17 / 1234", "Landtag des Saarlandes" —
 * while a sentence that happens to start a page and mention a Drucksache has verbs
 * in it. Requiring every lower-case word to come from this list is what keeps
 * "wurde im Landtag mit Drucksache 17/123 beraten" in the answer.
 */
const HEADER_LOWERCASE = new Set(["von", "des", "der", "und"]);

const DRUCKSACHE = String.raw`Drucksache\s+\d{1,2}\s*\/\s*\d[\d ]{0,7}`;
const PARLIAMENT_WORD = /Landtag|LANDTAG|Bundestag|Bürgerschaft|BÜRGERSCHAFT|Abgeordnetenhaus|Wahlperiode/;

function isRunningHeader(line: string): boolean {
  if (line.length > 130) return false;
  // Berlin and Rheinland-Pfalz print the bare number: "Drucksache 19 /12 345", "18/1234".
  if (new RegExp(`^(?:${DRUCKSACHE}|\\d{1,2}\\s*\\/\\s*\\d{1,6})$`).test(line)) return true;
  if (!new RegExp(DRUCKSACHE).test(line) || !PARLIAMENT_WORD.test(line)) return false;
  const lowercase = line.match(/(?<![\p{L}-])\p{Ll}[\p{L}]*/gu) ?? [];
  return lowercase.every((word) => HEADER_LOWERCASE.has(word));
}

/** "3", "- 3 -", "– 3 –": this page's number and nothing else. */
function isPageNumber(line: string, page: number): boolean {
  const match = /^[-–—]?\s*(\d{1,3})\s*[-–—]?$/.exec(line);
  return match !== null && Number(match[1]) === page;
}

/**
 * "Seite 3 von 6", "Seite 3 / 6", "3 von 6". The total makes these unambiguous, so
 * unlike a bare number they need not match this page's position: Berlin binds the
 * question and the answer into one PDF, and the answer counts its own pages from 1
 * ("Seite 3 von 10" on the fifth page of the file).
 */
function isPageOf(line: string): boolean {
  const match = /^(?:Seite\s+)?(\d{1,3})\s*(?:von|\/)\s*(\d{1,3})$/.exec(line);
  return match !== null && Number(match[1]) >= 1 && Number(match[1]) <= Number(match[2]);
}

/**
 * Lines a paper prints at the foot of a page that are about the paper. Each is the
 * form one parliament uses; none of them is a sentence an answer would end with.
 */
const FOOTER_LINES: readonly RegExp[] = [
  // Saarland, Niedersachsen, NRW: when the paper was issued or distributed.
  /^Ausgegeben:?\s*\d{1,2}\.\s?\d{1,2}\.\s?\d{4}(?:\s*\(\d{1,2}\.\s?\d{1,2}\.\s?\d{4}\))?$/,
  // Niedersachsen prints it with or without the page number in front of it.
  /^(?:\d{1,3}\s+)?\(verteilt am \d{1,2}\.\s?\d{1,2}\.\s?\d{4}\)$/i,
  /^Datum des Originals:\s*[\d.]+\s*\/\s*Ausgegeben:\s*[\d.]+$/,
  // Bundestag imprint.
  /^Gesamtherstellung: /,
  /^Vertrieb: Bundesanzeiger Verlag/,
  /^ISSN \d{4}-\d{3}[\dX]$/,
  // Hessen, Rheinland-Pfalz, Baden-Württemberg imprints.
  /^Herstellung: Kanzlei des Hessischen Landtags/,
  /^Druck: (?:Landtag Rheinland-Pfalz|Thüringer Landtag),/,
  /^Drucksachen und Plenarprotokolle sind im Internet/,
  /^abrufbar unter: www\.landtag-bw\.de/,
  /^_{10,}$/,
];

/**
 * Notes of several lines that close a page. They are matched as a whole block,
 * anchored at the end of the page, because their last lines ("… übermittelt.")
 * could end a real answer and must never be removed on their own.
 */
const FOOTER_BLOCKS: readonly RegExp[] = [
  // The Bundestag, on the first page of every answer (186 of 186 pages that carry
  // it, always in the last four lines).
  /\n?[ \t]*Die Antwort wurde namens der Bundesregierung mit Schreiben [^\n]*(?:\n[^\n]*){0,2}\n[ \t]*Die Drucksache enthält zusätzlich[^\n]*den Fragetext\.[ \t]*$/,
  // Mecklenburg-Vorpommern, at the foot of the answer's first page.
  /\n?[ \t]*(?:Die|Der|Das) [^\n]{3,140} hat namens der Landesregierung die Kleine Anfrage mit\n[ \t]*Schreiben vom [^\n]{6,30} beantwortet\.[ \t]*$/,
];

/**
 * Bayern closes every paper with a page headed "Hinweise des Landtagsamts" —
 * where the Fraktionen are listed and the Sitzungsübersicht can be found. Left in,
 * it becomes the tail of the last answer.
 */
const NOTICE_PAGE = /^Hinweise des Landtagsamts$/;

/**
 * Bayern's question list doubles as the table of contents: each question ends with
 * the page its answer is on ("… im Stadtgebiet Schweinfurt? 3"), and the list closes
 * with "Hinweise des Landtagsamts 6". A question does not end in a bare number after
 * its question mark, so the number goes and the mark stays.
 */
const TOC_PAGE_AFTER_QUESTION = /\?\s+\d{1,3}$/;
const TOC_NOTICE_ENTRY = /^Hinweise des Landtagsamts\s+\d{1,3}$/;

/** One page without its running lines. `page` is 1-based within its document. */
export function stripPageEdges(text: string, page: number): string {
  const lines = text.split("\n");
  const content = (i: number): string => (lines[i] as string).trim();

  // Running lines are peeled off each end while they keep coming; the first line
  // that is not one ends the edge. Only EDGE_LINES non-empty lines are looked at.
  let start = 0;
  for (let i = 0, seen = 0; i < lines.length && seen < EDGE_LINES; i++) {
    const line = content(i);
    if (line === "") continue;
    seen++;
    if (!isEdge(line, page, "top")) break;
    start = i + 1;
  }
  let end = lines.length;
  for (let i = lines.length - 1, seen = 0; i >= start && seen < EDGE_LINES; i--) {
    const line = content(i);
    if (line === "") continue;
    seen++;
    if (!isEdge(line, page, "bottom")) break;
    end = i;
  }

  let body = lines.slice(start, end).join("\n").replace(/\s+$/, "");
  for (const block of FOOTER_BLOCKS) body = body.replace(block, "");
  const kept = body.split("\n");
  const first = kept.find((line) => line.trim() !== "");
  if (first !== undefined && NOTICE_PAGE.test(first.trim())) return "";

  return kept
    .filter((line) => !TOC_NOTICE_ENTRY.test(line.trim()))
    .map((line) => (TOC_PAGE_AFTER_QUESTION.test(line.trimEnd()) ? line.trimEnd().replace(/\s+\d{1,3}$/, "") : line))
    .join("\n");
}

function isEdge(line: string, page: number, where: "top" | "bottom"): boolean {
  if (isRunningHeader(line) || isPageNumber(line, page) || isPageOf(line)) return true;
  return where === "bottom" && FOOTER_LINES.some((pattern) => pattern.test(line));
}

/**
 * The text segmentation reads: every page of every document stripped of its
 * running lines, joined with newlines. Page numbers restart with each document,
 * which is why this takes one document's text at a time.
 */
export function textForSegmentation(documentText: string): string {
  return documentText
    .split(PAGE_SEPARATOR)
    .map((page, index) => stripPageEdges(page, index + 1))
    .join("\n");
}
