// Running headers, footers and imprints — the lines a page repeats — kept out of
// the text that segmentation reads.

import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { stripPageEdges, textForSegmentation } from "../src/pages.js";

describe("page edges", () => {
  it("removes a running header at the top of a page", () => {
    // The Bayern, Bundestag and Saarland templates, as printed.
    for (const header of [
      "Drucksache 19 / 12365 Bayerischer Landtag 19. Wahlperiode Seite 4 / 6",
      "Deutscher Bundestag – 21. Wahlperiode – 3 – Drucksache 21/7652",
      "Drucksache 16/1665 (16/1631) Landtag des Saarlandes - 16. Wahlperiode -",
      "Landtag von Baden-Württemberg Drucksache 17 / 8906",
      "Drucksache 19 /12 345",
    ]) {
      strictEqual(stripPageEdges(`${header}\nDie Antwort geht weiter.`, 3), "Die Antwort geht weiter.");
    }
  });

  it("keeps a sentence that starts a page and mentions a Drucksache", () => {
    // A header is a name plate; this has verbs in it.
    const text = "wurde im Landtag mit Drucksache 17/123 beraten, und zwar zweimal.\nMehr Text.";
    strictEqual(stripPageEdges(text, 2), text);
  });

  it("removes a bare page number only when it is this page's number", () => {
    strictEqual(stripPageEdges("Text der Antwort.\n3", 3), "Text der Antwort.");
    strictEqual(stripPageEdges("Text der Antwort.\n- 3 -", 3), "Text der Antwort.");
    // The last figure of a table that happens to end page 3 is not a page number.
    strictEqual(stripPageEdges("Zahl der Fälle\n2024 14", 3), "Zahl der Fälle\n2024 14");
    strictEqual(stripPageEdges("Summe\n17", 3), "Summe\n17");
  });

  it("removes 'Seite X von Y' whatever page of the file it is on", () => {
    // Berlin binds question and answer into one PDF and the answer counts its own
    // pages, so "Seite 3 von 10" sits on the file's fifth page.
    strictEqual(stripPageEdges("Text der Antwort.\nSeite 3 von 10", 5), "Text der Antwort.");
    strictEqual(stripPageEdges("Text der Antwort.\nSeite 11 von 10", 5), "Text der Antwort.\nSeite 11 von 10");
  });

  it("removes the imprints printed at the foot of a paper", () => {
    const foot = [
      "Nein.",
      "Gesamtherstellung: H. Heenemann GmbH & Co. KG, Buch- und Offsetdruckerei, Berlin",
      "Vertrieb: Bundesanzeiger Verlag GmbH, Postfach 10 05 34, 50445 Köln",
      "ISSN 0722-8333",
    ].join("\n");
    strictEqual(stripPageEdges(foot, 4), "Nein.");
    strictEqual(stripPageEdges("Antwort.\nAusgegeben: 22.04.2021 (10.03.2021)", 1), "Antwort.");
    strictEqual(stripPageEdges("Antwort.\nDruck: Thüringer Landtag, 26. August 2025", 2), "Antwort.");
    strictEqual(stripPageEdges("Antwort.\n4 (Verteilt am 11.08.2025)", 4), "Antwort.");
  });

  it("removes the Bundestag's and Mecklenburg-Vorpommern's transmission notes as a block", () => {
    const bund = [
      "Die Fragen 1 und 2 werden zusammen beantwortet.",
      "Die Antwort wurde namens der Bundesregierung mit Schreiben des Bundesministeriums der Finanzen vom 16. März 2018",
      "übermittelt.",
      "Die Drucksache enthält zusätzlich – in kleinerer Schrifttype – den Fragetext.",
    ].join("\n");
    strictEqual(stripPageEdges(bund, 1), "Die Fragen 1 und 2 werden zusammen beantwortet.");
    const mv = [
      "Für das Schuljahr 2025/2026 liegt die Statistik noch nicht vor.",
      "Die Ministerin für Bildung und Kindertagesförderung hat namens der Landesregierung die Kleine Anfrage mit",
      "Schreiben vom 16. April 2026 beantwortet.",
    ].join("\n");
    strictEqual(stripPageEdges(mv, 1), "Für das Schuljahr 2025/2026 liegt die Statistik noch nicht vor.");
    // Half of a note is not the note: a real answer may end "… übermittelt."
    strictEqual(stripPageEdges("Die Daten wurden dem Ausschuss\nübermittelt.", 2), "Die Daten wurden dem Ausschuss\nübermittelt.");
  });

  it("drops Bayern's closing notice page", () => {
    const notice = "Hinweise des Landtagsamts\nFrakt. = Fraktion\nDie aktuelle Sitzungsübersicht steht unter www.bayern.landtag.de/aktuelles/sitzungen\nzur Verfügung.";
    strictEqual(stripPageEdges(notice, 6), "");
  });

  it("takes the table of contents' page numbers off a question list", () => {
    const list = [
      "1.1 Wie viele Unfallschwerpunkte gibt es im Stadtgebiet Schweinfurt? 3",
      "1.2 Was sind dort die häufigsten Unfallursachen? 3",
      "Hinweise des Landtagsamts 6",
    ].join("\n");
    strictEqual(
      stripPageEdges(list, 1),
      "1.1 Wie viele Unfallschwerpunkte gibt es im Stadtgebiet Schweinfurt?\n1.2 Was sind dort die häufigsten Unfallursachen?",
    );
  });

  it("numbers pages per document", () => {
    // Page numbers restart with every document; the second page here is page 2.
    const text = "Frage eins?\n1\fDrucksache 18/7 Landtag Brandenburg\nAntwort eins.\n2";
    strictEqual(textForSegmentation(text), "Frage eins?\nAntwort eins.");
  });
});
