// Segmentation, metadata rules, validators and the tier stack — everything between
// "we have some text" and "we have a record".

import { deepStrictEqual, match, ok, strictEqual, throws } from "node:assert/strict";
import { formatReference, parseReference, periodNumber, type Reference } from "../src/core/models/reference.js";
import { describe, it } from "node:test";
import {
  ANTWORT_FOLGT,
  FRAGE_ANTWORT,
  NUMMERIERT,
  applyRules,
  expandNumbers,
  normaliseNumber,
  RULE_SETS,
  segmentQa,
  groupedAnswerNumbers,
  splitAtAnswerDivider,
  splitAtQuestionMark,
} from "../src/core/extract/segment.js";
import {
  findDate,
  findMarkers,
  findMinistry,
  findReference,
  parseGermanDate,
  parseUrheber,
  periodFromReference,
} from "../src/core/extract/metadata.js";
import { validateExtractedRecord } from "../src/core/extract/validators.js";
import { extract } from "../src/core/extract/tiers.js";
import { abstainingPerceiver } from "../src/core/perceive/perceiver.js";
import { TesseractCliPerceiver } from "../src/core/perceive/tesseract-cli.js";
import { normalizeSpaces } from "../src/core/pdf/text.js";
import { readFixture, sampleRecord, questionPaper } from "./helpers.js";

const FRAGE_STYLE = `
Frage 1:
Wie viele Brücken sind marode?

Antwort zu 1:
Vierzehn.

Frage 2:
Und wie viele werden saniert?

Antwort zu 2:
Drei.
`;

const NUMMERIERT_STYLE = `
19. Wahlperiode
1. Wie viele Hundeparks gibt es?
a. Und wie ist ihr Zustand?
Zu 1.: Elf.
Zu 1 a): Gut.
2. Was kostet die Wartung?
Zu 2.: Nichts.
`;

describe("number lists in headings", () => {
  it("normalises the ways a document writes one number", () => {
    strictEqual(normaliseNumber("1"), "1");
    strictEqual(normaliseNumber("1 a"), "1a");
    strictEqual(normaliseNumber("1. a)"), "1a");
    strictEqual(normaliseNumber("2.1"), "2.1");
  });

  it("expands grouped and ranged headings", () => {
    deepStrictEqual(expandNumbers("1"), ["1"]);
    deepStrictEqual(expandNumbers("2 und 3"), ["2", "3"]);
    deepStrictEqual(expandNumbers("4 bis 6"), ["4", "5", "6"]);
    deepStrictEqual(expandNumbers("1, 2 und 3"), ["1", "2", "3"]);
  });

  it("refuses to expand an implausibly long range", () => {
    // A "range" of hundreds is a misread, and expanding it would fabricate
    // hundreds of question numbers.
    deepStrictEqual(expandNumbers("1 bis 500"), ["1", "500"]);
  });
});

describe("segmentation", () => {
  it("reads the Frage N: / Antwort zu N: family", () => {
    const result = segmentQa(FRAGE_STYLE);
    strictEqual(result.rules, "frage_antwort");
    strictEqual(result.segments.length, 2);
    strictEqual(result.segments[0]?.question, "Wie viele Brücken sind marode?");
    strictEqual(result.segments[0]?.answer, "Vierzehn.");
  });

  it("reads numbered questions with letter sub-items", () => {
    const result = segmentQa(NUMMERIERT_STYLE);
    strictEqual(result.rules, "nummeriert");
    deepStrictEqual(result.segments.map((segment) => segment.number), ["1", "1a", "2"]);
    strictEqual(result.segments[1]?.answer, "Gut.");
  });

  it("drops front matter that numbers itself", () => {
    // "19. Wahlperiode" is a numbered line on every Berlin cover page.
    const result = segmentQa(NUMMERIERT_STYLE);
    ok(!result.segments.some((segment) => segment.number === "19"));
  });

  it("does not read a date at the start of a line as a question", () => {
    const text = `1. Was war los?
Zu 1.: Nichts.
12. November 2021 war ein Freitag.
2. Und danach?
Zu 2.: Auch nichts.`;
    const result = segmentQa(text);
    deepStrictEqual(result.segments.map((segment) => segment.number), ["1", "2"]);
  });

  it("tolerates a document whose asker skipped a number", () => {
    // The shape of a real Berlin answer: the asker numbered 1, 2, 5, 6 and the
    // government answered 2 and 5 together, noting "siehe Ihre Nummerierung".
    const text = `1. Erste Frage?
Zu 1.: Eins.
2. Zweite Frage?
5. Fünfte Frage?
Zu 2. und 5. (siehe Ihre Nummerierung): Zwei und fünf.
6. Sechste Frage?
Zu 6.: Sechs.`;
    const result = segmentQa(text);
    strictEqual(result.rules, "nummeriert");
    ok(result.segments.some((segment) => segment.number === "5"));
  });

  it("refuses a reading where the numbers are scattered over a huge range", () => {
    const text = `1. Eine Frage?
Zu 1.: Eine Antwort.
115. Noch eine?
Zu 115.: Und noch eine.`;
    const result = segmentQa(text);
    strictEqual(result.rules, undefined);
    ok(result.rejections.some((reason) => reason.includes("of the numbers 1..115")));
  });

  it("refuses a text with no headings at all rather than inventing one pair", () => {
    const result = segmentQa("Ein Fließtext ohne jede Nummerierung und ohne Fragen.");
    strictEqual(result.rules, undefined);
    strictEqual(result.segments.length, 0);
    ok(result.rejections.length >= 2);
  });

  it("prefers the rule set that recognises the most questions", () => {
    // Both families' answer patterns can fire on `Zu N:`; only the numbered family
    // can see these questions, so it must win.
    const onlyNumbered = applyRules(NUMMERIERT_STYLE, FRAGE_ANTWORT);
    ok(onlyNumbered.segments.every((segment) => segment.question === undefined));
    strictEqual(segmentQa(NUMMERIERT_STYLE).rules, NUMMERIERT.key);
  });
});

const BUNDESTAG_STYLE = `
21. Wahlperiode 17.08.2026
Antwort
der Bundesregierung
 1. Wie viele Beschwerden gab es?
Es gab vierzehn.
 2. Und wie viele Verfahren?
Drei, verteilt auf zwei Jahre.
 3. Plant die Bundesregierung etwas?
Nein.
`;

describe("the Bundestag heading family", () => {
  it("splits a block at the last line ending in a question mark", () => {
    const split = splitAtQuestionMark("Wie viele X?\nUnd wie viele Y?\nEs sind vierzehn.\nMehr nicht.");
    strictEqual(split.question, "Wie viele X?\nUnd wie viele Y?");
    strictEqual(split.answer, "Es sind vierzehn.\nMehr nicht.");
  });

  it("abstains on the answer when nothing follows the question", () => {
    const split = splitAtQuestionMark("Wie viele X?");
    strictEqual(split.answer, undefined);
  });

  it("reads questions whose answer has no heading at all", () => {
    const result = segmentQa(BUNDESTAG_STYLE);
    strictEqual(result.rules, ANTWORT_FOLGT.key);
    strictEqual(result.segments.length, 3);
    strictEqual(result.segments[0]?.answer, "Es gab vierzehn.");
    strictEqual(result.segments[2]?.answer, "Nein.");
  });

  it("needs the PDF reader to have folded the alignment spaces first", () => {
    // The Bundestag right-aligns question numbers with U+2002 EN SPACE. These rules
    // match ordinary spaces and tabs only, so the folding has to happen upstream in
    // `normalizeSpaces`. This pins both halves of that contract.
    strictEqual(applyRules(" 1. Eine Frage?\nEine Antwort.", ANTWORT_FOLGT).rejection, undefined);
    ok(applyRules("\u20021. Eine Frage?\nEine Antwort.", ANTWORT_FOLGT).rejection !== undefined);
    strictEqual(
      applyRules(normalizeSpaces("\u20021. Eine Frage?\nEine Antwort."), ANTWORT_FOLGT).rejection,
      undefined,
    );
  });

  it("stands aside when the document does have answer headings", () => {
    const { rejection } = applyRules(NUMMERIERT_STYLE, ANTWORT_FOLGT);
    match(rejection ?? "", /the document has answer headings/);
  });

  it("refuses an inferred split that only worked for a few questions", () => {
    // The shape of a Bundestag answer that reprints the whole question list first:
    // the questions run together, so almost nothing splits.
    const listFirst = [
      "1. Erste Frage?",
      "2. Zweite Frage?",
      "3. Dritte Frage?",
      "4. Vierte Frage?",
      "5. Fünfte Frage?",
      "Die Fragen werden gemeinsam beantwortet: alles bestens.",
    ].join("\n");
    const { rejection } = applyRules(listFirst, ANTWORT_FOLGT);
    match(rejection ?? "", /too few to trust an inferred split/);
  });

  it("does not crash on an empty line", () => {
    // A regex written to never match (`/$^/`) matches an empty string; the family
    // declares "no answer pattern" instead, and this pins that.
    strictEqual(ANTWORT_FOLGT.answer, undefined);
    ok(segmentQa("\n\n\n").rules === undefined);
  });
});

describe("Schleswig-Holstein's heading style", () => {
  const SH_STYLE = [
    "Kleine Anfrage",
    "der Abgeordneten Birte Pauls (SPD)",
    "und Antwort",
    "der Landesregierung",
    "1. Welche Maßnahmen werden aktuell vorbereitet?",
    "Antwort:",
    "Die Landesregierung setzt sich auf Bundesebene ein.",
    "2. Welche neuen Initiativen gibt es?",
    "Antwort:",
    "Siehe Antwort zu Frage 1.",
  ].join("\n");

  it("attaches a bare `Antwort:` to the question above it", () => {
    const result = segmentQa(SH_STYLE);
    strictEqual(result.rules, NUMMERIERT.key);
    strictEqual(result.segments.length, 2);
    strictEqual(result.segments[0]?.answer, "Die Landesregierung setzt sich auf Bundesebene ein.");
    strictEqual(result.segments[1]?.answer, "Siehe Antwort zu Frage 1.");
  });

  it("ignores a bare `Antwort` with no colon, which is a cover-page word", () => {
    // The Bundestag's cover page carries "Antwort" on its own line above "der
    // Bundesregierung"; treating that as a heading would swallow the document.
    const withCover = "Antwort\nder Bundesregierung\n1. Eine Frage?\nAntwort:\nEine Antwort.";
    const result = segmentQa(withCover);
    strictEqual(result.segments.length, 1);
    strictEqual(result.segments[0]?.answer, "Eine Antwort.");
  });

  it("ignores an unnumbered answer that appears before any question", () => {
    strictEqual(segmentQa("Antwort:\nIrgendwas.").rules, undefined);
  });
});

describe("numbered items that are not questions", () => {
  it("refuses a number that jumps far ahead of the list", () => {
    // "101. Arbeits- und Sozialministerkonferenz" wrapped from the sentence above
    // is prose, not question 101.
    const text = [
      "1. Erste Frage?", "Antwort:", "Eins.",
      "2. Zweite Frage?", "Antwort:", "Zwei, beschlossen auf der",
      "101. Arbeits- und Sozialministerkonferenz.",
    ].join("\n");
    const result = segmentQa(text);
    deepStrictEqual(result.segments.map((segment) => segment.number), ["1", "2"]);
  });

  it("still allows an asker who skipped a number or two", () => {
    // The real Berlin shape: numbered 1, 2, 5, 6. The skip guard lets 5 through, and
    // the density check then accepts 4 of 1..6.
    const text = [
      "1. Erste?", "Antwort:", "Eins.",
      "2. Zweite?", "Antwort:", "Zwei.",
      "5. Fünfte?", "Antwort:", "Fünf.",
      "6. Sechste?", "Antwort:", "Sechs.",
    ].join("\n");
    deepStrictEqual(segmentQa(text).segments.map((segment) => segment.number), ["1", "2", "5", "6"]);
  });

  it("refuses a long numbered list that is almost entirely unanswered", () => {
    // Six real questions followed by a numbered table of schools and pools: every
    // row matches, the numbering is perfectly dense, and one answer would otherwise
    // be enough to make the whole thing look like a question list.
    const rows = Array.from({ length: 40 }, (_, i) => `${i + 2}. Schwimmhalle Nummer ${i + 2} Hallenbad Ja`);
    const text = ["1. Wie viel Schwimmunterricht gab es?", "Antwort:", "Viel.", ...rows].join("\n");
    const result = segmentQa(text);
    strictEqual(result.rules, undefined);
    ok(result.rejections.some((reason) => reason.includes("numbered table")));
  });
});

describe("a document that is really two halves", () => {
  it("splits at a standalone Antwort divider when the whole will not read", () => {
    // Bayern's shape: the question list, the word "Antwort", then the questions
    // again with the replies. Read as one text it is every question asked twice.
    const text = [
      "1.1 Wie hat sich die Zahl entwickelt?",
      "1.2 Welche Erkenntnisse gibt es?",
      "Antwort",
      "1.1 Wie hat sich die Zahl entwickelt?",
      "Sie ist gestiegen.",
      "1.2 Welche Erkenntnisse gibt es?",
      "Keine.",
    ].join("\n");
    const divided = splitAtAnswerDivider(text);
    ok(divided !== undefined);
    match(divided.questions, /^1\.1 /);
    match(divided.answers, /Sie ist gestiegen/);
  });

  it("does not split at a cover-page Antwort with no questions above it", () => {
    // The Bundestag's cover has "Antwort" over "der Bundesregierung".
    strictEqual(splitAtAnswerDivider("Antwort\nder Bundesregierung\n1. Eine Frage?\nJa."), undefined);
  });

  it("does not split a document with nothing after the divider", () => {
    strictEqual(splitAtAnswerDivider("1. Eine Frage?\nAntwort\n"), undefined);
  });
});

describe("`Frage N:` questions whose answer follows directly", () => {
  it("reads a ministry letter that restates each question and answers beneath it", () => {
    const text = [
      "Frage 1: Wie schlüsseln sich die Eigentumsverhältnisse auf?",
      "Der Freistaat hält 77 Prozent.",
      "Frage 2: Welche Gespräche finden statt?",
      "Laufende Gespräche mit den Gesellschaftern.",
    ].join("\n");
    const result = segmentQa(text);
    strictEqual(result.rules, "frage_antwort_folgt");
    strictEqual(result.segments[0]?.answer, "Der Freistaat hält 77 Prozent.");
    strictEqual(result.segments[1]?.answer, "Laufende Gespräche mit den Gesellschaftern.");
  });

  it("stands aside when the document does mark its answers", () => {
    // `frage_antwort` can read this one, and reading a heading beats inferring one.
    const marked = "Frage 1: Eine Frage?\nAntwort zu 1:\nEine Antwort.";
    strictEqual(segmentQa(marked).rules, FRAGE_ANTWORT.key);
  });
});

describe("the heading styles of the remaining Länder", () => {
  it("reads Bayern's hierarchical numbering, which has no trailing dot", () => {
    const text = [
      "1.1 Wie hat sich die Zahl psychiatrischer Notfälle entwickelt?",
      "Antwort:", "Sie ist gestiegen.",
      "1.2 Welche Erkenntnisse hat die Staatsregierung?",
      "Antwort:", "Keine.",
      "2.1 Wie viele Übergriffe gab es?",
      "Antwort:", "Vierzehn.",
    ].join("\n");
    deepStrictEqual(segmentQa(text).segments.map((segment) => segment.number), ["1.1", "1.2", "2.1"]);
  });

  it("does not read a date or a thousands-separated figure as a number", () => {
    // Both of these appeared at the start of a line in real documents and were read
    // as question numbers when the hierarchical form was first allowed.
    const text = [
      "1. Erste Frage?", "Antwort:", "Am",
      "02.08.2024 wurde entschieden, es waren",
      "1.154.000 Euro.",
      "2. Zweite Frage?", "Antwort:", "Ja.",
    ].join("\n");
    deepStrictEqual(segmentQa(text).segments.map((segment) => segment.number), ["1", "2"]);
  });

  it("reads Sachsen-Anhalt's `Antwort auf Frage N:`", () => {
    const text = [
      "Frage 1:", "Wie viele Fälle gab es?",
      "Antwort auf Frage 1:", "Vierzehn.",
      "Frage 2:", "Und wie viele davon wurden bearbeitet?",
      "Antwort auf Frage 2:", "Drei.",
    ].join("\n");
    const result = segmentQa(text);
    strictEqual(result.rules, FRAGE_ANTWORT.key);
    strictEqual(result.segments[0]?.answer, "Vierzehn.");
    strictEqual(result.segments[1]?.answer, "Drei.");
  });

  it("reads Mecklenburg-Vorpommern's `Zu a)` sub-answers", () => {
    const text = [
      "1. In welcher Planungsregion ist das der Fall?",
      "a) Welche zwingenden Gründe gibt es?",
      "b) Welche Maßnahmen wurden ergriffen?",
      "Zu a)", "Es gab keine.",
      "Zu b)", "Auch keine.",
    ].join("\n");
    const result = segmentQa(text);
    const byNumber = new Map(result.segments.map((segment) => [segment.number, segment.answer]));
    strictEqual(byNumber.get("1a"), "Es gab keine.");
    strictEqual(byNumber.get("1b"), "Auch keine.");
  });
});

describe("grouped answers", () => {
  it("reads the numbers a government says it is answering together", () => {
    deepStrictEqual(
      groupedAnswerNumbers("Die Fragen 1 und 2 werden aufgrund des Sachzusammenhangs gemeinsam beantwortet."),
      ["1", "2"],
    );
    deepStrictEqual(groupedAnswerNumbers("Die Fragen 1 bis 18 werden zusammen beantwortet."), [
      "1","2","3","4","5","6","7","8","9","10","11","12","13","14","15","16","17","18",
    ]);
  });

  it("ignores such a sentence deep inside a long answer", () => {
    // Only the opening of an answer announces its scope; a sentence 400 characters
    // in is discussing something else.
    deepStrictEqual(groupedAnswerNumbers("x".repeat(500) + " Die Fragen 1 und 2 werden gemeinsam beantwortet."), []);
  });

  it("attaches a grouped answer to every question it covers", () => {
    const text = [
      "1. Wie oft wurde gefragt?",
      "",
      "2. Und wann? (Bitte nach Datum aufschlüsseln)",
      "",
      "Die Fragen 1 und 2 werden aufgrund des Sachzusammenhangs gemeinsam beantwortet.",
      "",
      "Dreimal, im Mai.",
    ].join("\n");
    const result = segmentQa(text);
    strictEqual(result.segments.length, 2);
    ok(result.segments[0]?.answer?.startsWith("Die Fragen 1 und 2"));
    strictEqual(result.segments[0]?.answer, result.segments[1]?.answer);
  });

  it("splits a question that ends in a parenthetical after the question mark", () => {
    // The NRW shape: "… zu gewinnen? (Bitte nach Maßnahmenart differenzieren)".
    const split = splitAtQuestionMark("1. Wie viele?\n(Bitte aufschlüsseln)\n\nEs sind vierzehn.");
    strictEqual(split.question, "1. Wie viele?\n(Bitte aufschlüsseln)");
    strictEqual(split.answer, "Es sind vierzehn.");
  });
});

describe("metadata rules", () => {
  it("parses the German date forms parliamentary documents use", () => {
    strictEqual(parseGermanDate("04.11.2021"), "2021-11-04");
    strictEqual(parseGermanDate("4. November 2021"), "2021-11-04");
    strictEqual(parseGermanDate("04. Nov. 2021"), "2021-11-04");
    strictEqual(parseGermanDate("2021-11-04"), "2021-11-04");
  });

  it("refuses a two-digit year rather than guessing a century", () => {
    strictEqual(parseGermanDate("04.11.21"), undefined);
  });

  it("refuses an impossible date", () => {
    strictEqual(parseGermanDate("31.02.2024"), undefined);
  });

  it("finds the first usable date in running text", () => {
    strictEqual(findDate("Eingang beim Abgeordnetenhaus am 04. November 2021 (…)"), "2021-11-04");
  });

  it("reads a Drucksachennummer, including the spaced cover-page form", () => {
    strictEqual(findReference("Drucksache 19 / 10 006"), "19/10006");
    strictEqual(findReference("Drucksache 18/27064"), "18/27064");
    strictEqual(periodFromReference("19/10006"), 19);
  });

  it("does not weld a reference together across a line break", () => {
    // `\s` spanned newlines, so two unrelated lines of a PDF text layer read as
    // one Drucksachennummer — a fabricated identity is worse than no reference.
    strictEqual(findReference("Drucksache 19/10\n006 vom heute"), "19/10");
  });

  it("only reads a number that carries its label", () => {
    // A bare `a/b` is not evidence of a Drucksachennummer, and reading one as such
    // produced real misreadings. Structure cannot separate them — `11/2024` is a
    // perfectly well-formed reference — so only the label can.
    strictEqual(findReference("Seite 2 / 4\nDrucksache 19 / 6524"), "19/6524");
    strictEqual(findReference("im Verhältnis 2/3 der Stimmen, Drucksache 19/6524"), "19/6524");
    strictEqual(findReference("Stand 11/2024 — siehe Drucksache 19/6524"), "19/6524");
    strictEqual(findReference("19/10006 steht hier ohne Bezeichnung"), undefined);
  });

  it("knows the labels the parliaments actually print", () => {
    // Every form below is taken from a golden: Drucksache (eleven of fifteen,
    // uppercase in Sachsen), Schriftliche Anfrage Nr. (Berlin), Kleine Anfrage
    // (Thüringen, which labels the question paper by its document type).
    strictEqual(findReference("Sächsischer Landtag DRUCKSACHE 8/3284"), "8/3284");
    strictEqual(findReference("Antwort auf die Schriftliche Anfrage Nr. 19 / 10 006"), "19/10006");
    strictEqual(findReference("8. Wahlperiode Kleine Anfrage 8/980"), "8/980");
    strictEqual(findReference("vgl. BT-Drs. 21/7449"), "21/7449");
    strictEqual(findReference("Drucks. Nr. 18/27 064"), "18/27064");
  });

  it("normalises a string that is already a reference, without a label", () => {
    // Whole-string, the way `parseGermanDate` is to `findDate`.
    deepStrictEqual(parseReference("19 / 10 006"), { period: "19", number: "10006" });
    deepStrictEqual(parseReference(" 18/27064 "), { period: "18", number: "27064" });
    strictEqual(parseReference("Drucksache 19/10006"), undefined);
    strictEqual(parseReference("2/3 der Stimmen"), undefined);
    // Padding is how a Land prints it and is not ours to drop, so both halves are
    // strings and the printed form round-trips.
    deepStrictEqual(parseReference("08/980"), { period: "08", number: "980" });
    strictEqual(formatReference(parseReference("08/980") as Reference), "08/980");
    strictEqual(periodNumber(parseReference("08/980") as Reference), 8);
  });

  it("splits a PARDOK Urheber field into askers", () => {
    deepStrictEqual(parseUrheber("Otto, Andreas (Grüne)").askers, [{ name: "Andreas Otto", party: "Grüne" }]);
    deepStrictEqual(parseUrheber("Goldner, Antonia-Katharina, Dr., CDU; CDU").askers, [
      { name: "Dr. Antonia-Katharina Goldner", party: "CDU" },
    ]);
  });

  it("does not turn a bare Fraktion into a person", () => {
    deepStrictEqual(parseUrheber("CDU").askers, []);
  });

  it("does not turn a Fraktion spelled out beside its abbreviation into a person", () => {
    // Schleswig-Holstein repeats the Fraktion in full. Every real person in this
    // field is written surname-first, so the missing comma is what gives it away.
    deepStrictEqual(parseUrheber("Sozialdemokratische Partei Deutschlands (SPD)").askers, []);
    deepStrictEqual(parseUrheber("Freie Demokratische Partei (FDP)").askers, []);
  });

  it("keeps an office out of the askers and reports it as a body", () => {
    // Schleswig-Holstein files question and answer as one document, so the
    // minister who answered is in the same field as the asker. Read as a person,
    // the trailing-party rule split the ministry's name in half and made
    // "Forschung und Kultur" somebody's political party.
    const field =
      "Krämer, Annabell (FDP); Freie Demokratische Partei (FDP); " +
      "Minister/in für Allgemeine und Berufliche Bildung, Wissenschaft, Forschung und Kultur";
    const parsed = parseUrheber(field);
    deepStrictEqual(parsed.askers, [{ name: "Annabell Krämer", party: "FDP" }]);
    deepStrictEqual(parsed.bodies, ["Minister/in für Allgemeine und Berufliche Bildung, Wissenschaft, Forschung und Kultur"]);
  });

  it("recognises the other shapes a Land writes an office in", () => {
    deepStrictEqual(parseUrheber("Senatsverwaltung für Inneres und Sport").bodies.length, 1);
    deepStrictEqual(parseUrheber("Niedersächsisches Ministerium für Umwelt, Energie und Klimaschutz").bodies.length, 1);
    deepStrictEqual(parseUrheber("Niedersächsische Staatskanzlei").bodies.length, 1);
    deepStrictEqual(parseUrheber("Landesregierung").bodies.length, 1);
    // A person is still a person.
    deepStrictEqual(parseUrheber("Ministerowitsch, Anna (CDU)").bodies, []);
  });

  it("finds the answering ministry", () => {
    strictEqual(
      findMinistry("Senatsverwaltung für Umwelt, Verkehr und Klimaschutz\nHerrn Abgeordneten"),
      "Senatsverwaltung für Umwelt, Verkehr und Klimaschutz",
    );
  });

  it("collects attachment references and the classification marker", () => {
    const markers = findMarkers("siehe Anlage 2 und Anlage 10.\nVS-NUR FÜR DEN DIENSTGEBRAUCH");
    strictEqual(markers.classified, true);
    deepStrictEqual(markers.attachments_referenced, ["Anlage 2", "Anlage 10"]);
  });
});

describe("a question number that appears twice", () => {
  const doc = (lines: string[]) => lines.join("\n");

  it("abstains when the two occurrences ask different things", () => {
    // Keeping the first is right for a restatement and wrong for a contradiction,
    // and from here they are indistinguishable — so the question abstains rather
    // than one of them being picked silently.
    const result = segmentQa(
      doc(["Frage 1:", "ERSTE FRAGE?", "Antwort zu 1:", "X.", "Frage 1:", "GANZ ANDERE FRAGE?", "Antwort zu 1:", "Y."]),
      RULE_SETS,
    );
    strictEqual(result.segments.length, 1);
    strictEqual(result.segments[0]?.question, undefined);
    strictEqual(result.segments[0]?.answer, "X.");
  });

  it("keeps the question for every restatement shape the corpus actually contains", () => {
    const cases: [string, string[]][] = [
      ["verbatim", ["Frage 1:", "Wie viele?", "Frage 1:", "Wie viele?", "Antwort zu 1:", "X."]],
      ["one copy truncated", ["Frage 1:", "Wie viele Brücken sind marode?", "Frage 1:", "Wie viele Brücken", "Antwort zu 1:", "X."]],
      // Baden-Württemberg's text layer inserts a space mid-word ("W elche"),
      ["a space inside a word", ["Frage 1:", "W elche Träger?", "Frage 1:", "Welche Träger?", "Antwort zu 1:", "X."]],
      // and breaks a word across a line ("Land-\nkreis" vs "Landkreis").
      ["a hyphenated line break", ["Frage 1:", "Im Land-", "kreis Karlsruhe?", "Frage 1:", "Im Landkreis Karlsruhe?", "Antwort zu 1:", "X."]],
    ];
    for (const [label, lines] of cases) {
      const result = segmentQa(doc(lines), RULE_SETS);
      ok(result.segments[0]?.question !== undefined, `${label}: the question was dropped`);
    }
  });
});

describe("a reply that enumerates its own findings", () => {
  const doc = (lines: string[]) => segmentQa(lines.join("\n"), RULE_SETS);

  it("absorbs the list instead of publishing its last item as a question", () => {
    // The commonest shape in the corpus. The list both truncated the answer it
    // belonged to and produced a third question nobody asked; the table guard
    // never fires because three items is far below LARGE_QUESTION_LIST.
    const result = doc([
      "1. Wie viele Brücken sind sanierungsbedürftig?",
      "2. Welche Mittel stehen bereit?",
      "Zu 1.",
      "Nach Auswertung der Bauwerksprüfungen:",
      "1. Zustandsnote 3,0 bis 3,4: 14 Stück",
      "2. Zustandsnote 3,5 und schlechter: 6 Stück",
      "3. Bauwerke ohne aktuelle Prüfung: 2 Stück",
      "Zu 2.",
      "Im Haushalt 2025 sind 4,2 Mio. Euro veranschlagt.",
    ]);
    deepStrictEqual(result.segments.map((segment) => segment.number), ["1", "2"]);
    // …and the figures that were the point of asking stay in the answer.
    match(result.segments[0]?.answer ?? "", /14 Stück/);
    match(result.segments[0]?.answer ?? "", /2 Stück/);
  });

  it("does not swallow a real question that follows an answer", () => {
    // Baden-Württemberg prints all its questions, then restates each above its
    // answer; a strictly interleaved document does the same thing question by
    // question. Neither may be mistaken for a list.
    deepStrictEqual(
      doc(["1. Frage eins?", "2. Frage zwei?", "Zu 1. und 2.", "Gemeinsame Antwort.", "3. Frage drei?", "Zu 3.", "Antwort drei."])
        .segments.map((segment) => segment.number),
      ["1", "2", "3"],
    );
    deepStrictEqual(
      doc(["1. Frage eins?", "Zu 1.", "Antwort eins.", "2. Frage zwei?", "Zu 2.", "Antwort zwei."])
        .segments.map((segment) => segment.number),
      ["1", "2"],
    );
  });
});

describe("an answer number that appears twice", () => {
  it("keeps the first body, deliberately — a recurring heading is not a second answer", () => {
    // Not symmetric with the question case, and the corpus is why. An answer
    // heading recurs mid-answer: the Saarland reply to 17/1331 heads number 4
    // again and continues "…dargelegt, sind Konzeptvergaben grundsätzlich…",
    // which shares no prefix with the first body and is still the same answer.
    // Treating a differing repeat as a contradiction there abstained on three
    // goldens' worth of correct text, so the first body wins and stays whole.
    const result = segmentQa(
      ["Frage 1:", "A?", "Antwort zu 1:", "ERSTE ANTWORT.", "Antwort zu 1:", "ZWEITE ANTWORT."].join("\n"),
      RULE_SETS,
    );
    strictEqual(result.segments[0]?.answer, "ERSTE ANTWORT.");
  });
});

describe("two papers that ask the same number differently", () => {
  const page = (lines: string[]) => questionPaper(lines);
  const meta = { reference: "19/1", legislative_period: 19, title: "T", askers: [], answered_by: {}, dates: {} };
  const both = async (questionLines: string[]) =>
    (
      await extract({
        parliament: "berlin",
        documentType: "schriftliche_anfrage",
        tier: "text_layer",
        metadata: meta,
        env: {},
        documents: [
          { role: "question_pdf", url: "https://x.invalid/q.pdf", bytes: page(questionLines), urlStable: true },
          {
            role: "combined_pdf",
            url: "https://x.invalid/c.pdf",
            bytes: page(["1. Wie viele Bruecken sind marode?", "Zu 1.", "Antworttext."]),
            urlStable: true,
          },
        ],
      })
    ).record;

  it("abstains on the question rather than letting the first-read paper win", async () => {
    const record = await both(["1. GANZ ANDERE FRAGE?"]);
    strictEqual(record.qa[0]?.question, undefined);
    ok(record.extraction.abstained_fields.includes("qa[0].question"));
    // The answer is not in doubt, so it stays.
    strictEqual(record.qa[0]?.answer, "Antworttext.");
  });

  it("keeps the question when the papers agree, including a truncated copy", async () => {
    strictEqual((await both(["1. Wie viele Bruecken sind marode?"])).qa[0]?.question, "Wie viele Bruecken sind marode?");
    strictEqual((await both(["1. Wie viele Bruecken"])).qa[0]?.question, "Wie viele Bruecken");
  });
});

describe("a question paper", () => {
  it("is read as questions, not refused for having no answers", async () => {
    // The guard that refuses a reading with no answers exists to reject numbered
    // tables — but a question paper has no answers by definition, so it refused
    // every one of them. Niedersachsen's documented degraded mode ("yields
    // question-only records") produced zero pairs instead.
    const { record } = await extract({
      parliament: "berlin",
      documentType: "schriftliche_anfrage",
      tier: "text_layer",
      metadata: { reference: "19/1", legislative_period: 19, title: "T", askers: [], answered_by: {}, dates: {} },
      documents: [
        {
          role: "question_pdf",
          url: "https://x.invalid/q.pdf",
          bytes: questionPaper(["1. Wie viele Brücken sind marode?", "2. Welche Mittel stehen bereit?"]),
          urlStable: true,
        },
      ],
      env: {},
    });
    deepStrictEqual(record.qa.map((pair) => pair.number), ["1", "2"]);
    ok(record.qa.every((pair) => pair.question !== undefined));
    // The holes are still visible: no answers were found, and the record says so.
    ok(record.qa.every((pair) => pair.answer === undefined));
    ok(record.extraction.abstained_fields.includes("qa[0].answer"));
  });

  it("still refuses a numbered table that arrives as a question paper", async () => {
    // Dropping the answer requirement must not drop the numbering guards.
    const { record } = await extract({
      parliament: "berlin",
      documentType: "schriftliche_anfrage",
      tier: "text_layer",
      metadata: { reference: "19/2", legislative_period: 19, title: "T", askers: [], answered_by: {}, dates: {} },
      documents: [
        {
          role: "question_pdf",
          url: "https://x.invalid/t.pdf",
          bytes: questionPaper(["7. Schule A", "34. Schule B", "112. Schule C"]),
          urlStable: true,
        },
      ],
      env: {},
    });
    strictEqual(record.qa.length, 0);
    ok(record.extraction.abstained_fields.includes("qa"));
  });
});

describe("validators", () => {
  it("passes a sound record", () => {
    deepStrictEqual(validateExtractedRecord(sampleRecord()), []);
  });

  it("rejects a date outside the plausible range", () => {
    const record = sampleRecord({ dates: { submitted: "1823-01-01" } });
    ok(validateExtractedRecord(record).some((problem) => problem.path === "dates.submitted"));
  });

  it("abstains on a title the source did not carry", () => {
    // Every adapter writes `?? ""` for a missing title, and an empty title was
    // otherwise indistinguishable from a document that genuinely has none — the
    // one field that could go missing without appearing in `abstained_fields`.
    deepStrictEqual(
      validateExtractedRecord(sampleRecord({ title: "" })).map((problem) => problem.path),
      ["title"],
    );
    deepStrictEqual(validateExtractedRecord(sampleRecord({ title: "   " })).map((p) => p.path), ["title"]);
    deepStrictEqual(validateExtractedRecord(sampleRecord({ title: "Ein Titel" })), []);
  });

  it("judges a future date against the archive, not against the clock", () => {
    const record = sampleRecord({ dates: { submitted: "2028-05-01" } });
    // Retrieved in 2026, a 2028 date is dated in advance...
    ok(
      validateExtractedRecord(record, new Date("2026-09-22T00:00:00Z")).some(
        (problem) => problem.path === "dates.submitted",
      ),
    );
    // ...and the same bytes retrieved in 2028 are not. The decision follows the
    // archive, so re-extracting an old record never changes its abstentions.
    deepStrictEqual(validateExtractedRecord(record, new Date("2028-09-22T00:00:00Z")), []);
  });

  it("leaves the upper bound unasserted when no instant is known", () => {
    const record = sampleRecord({ dates: { submitted: "2999-01-01" } });
    deepStrictEqual(validateExtractedRecord(record), []);
    // The lower bound needs no clock, so it still holds.
    ok(
      validateExtractedRecord(sampleRecord({ dates: { submitted: "1823-01-01" } })).some(
        (problem) => problem.path === "dates.submitted",
      ),
    );
  });

  it("abstains on the answering ministry of an answered document", () => {
    // The last field whose hole was invisible: it was simply absent, and
    // `abstained_fields` and `review_status` said nothing about it.
    deepStrictEqual(
      validateExtractedRecord(sampleRecord({ answered_by: {} })).map((problem) => problem.path),
      ["answered_by.ministry"],
    );
  });

  it("does not abstain on the ministry of a document nobody has answered", () => {
    // "We do not know who answered" and "nobody has answered" are different facts,
    // and abstaining on the second would make needs_review meaningless.
    const unanswered = sampleRecord({
      answered_by: {},
      dates: { submitted: "2024-03-01" },
      qa: [{ number: "1", question: "Wie viele Brücken sind marode?" }],
      source_documents: [
        {
          role: "question_pdf",
          url: "https://example.invalid/19-12345.pdf",
          sha256: "0".repeat(64),
          url_stable: true,
        },
      ],
    });
    deepStrictEqual(validateExtractedRecord(unanswered), []);
  });

  it("reads answeredness from any of the three signals a Land gives", () => {
    const bare = {
      answered_by: {},
      dates: { submitted: "2024-03-01" },
      qa: [{ number: "1", question: "Frage?" }],
      source_documents: [
        { role: "question_pdf" as const, url: "https://x.invalid/q.pdf", sha256: "0".repeat(64), url_stable: true },
      ],
    };
    const paths = (overrides: Parameters<typeof sampleRecord>[0]): string[] =>
      validateExtractedRecord(sampleRecord({ ...bare, ...overrides })).map((problem) => problem.path);

    // An answer date, as the Bundestag's metadata gives it...
    deepStrictEqual(paths({ dates: { submitted: "2024-03-01", answered: "2024-03-28" } }), ["answered_by.ministry"]);
    // ...a Q/A pair that has an answer, where the reply was segmented...
    deepStrictEqual(paths({ qa: [{ number: "1", question: "Frage?", answer: "Antwort." }] }), ["answered_by.ministry"]);
    // ...or an answer document, which is all Saarland's prose reply leaves behind.
    deepStrictEqual(
      paths({
        source_documents: [
          { role: "answer_pdf", url: "https://x.invalid/a.pdf", sha256: "0".repeat(64), url_stable: true },
        ],
      }),
      ["answered_by.ministry"],
    );
  });

  it("rejects a question that swallowed the rest of the document", () => {
    const record = sampleRecord({ qa: [{ number: "1", question: "x".repeat(20_001) }] });
    ok(validateExtractedRecord(record).some((problem) => problem.path === "qa[0].question"));
  });
});

describe("reading more than one document", () => {
  const metadata = {
    reference: "17/1331",
    legislative_period: 17,
    title: "Zwei Papiere",
    askers: [],
    // Saarland's result row names it, and an answered record without one abstains,
    // which would put an unrelated entry in every `abstained_fields` below.
    answered_by: { ministry: "Landesregierung" },
    dates: {},
  };

  /** A minimal PDF holding the given text, so the tier can be driven end to end. */
  function pdf(lines: string[]): Buffer {
    const content = lines
      .map((line, i) => `BT /F1 12 Tf 72 ${760 - i * 18} Td (${line.replace(/([()\\])/g, "\\$1")}) Tj ET`)
      .join("\n");
    return Buffer.from(
      [
        "%PDF-1.4",
        "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
        "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
        "3 0 obj << /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >> endobj",
        `4 0 obj << /Length ${content.length} >> stream\n${content}\nendstream endobj`,
        "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >> endobj",
        "trailer << /Root 1 0 R >>",
        "%%EOF",
      ].join("\n"),
      "latin1",
    );
  }

  const questionPaper = pdf(["1. Erste Frage?", "2. Zweite Frage?"]);
  const answerPaper = pdf(["Zu 1.:", "Erste Antwort.", "Zu 2.:", "Zweite Antwort."]);

  it("takes questions from the question paper and answers from the answer paper", async () => {
    // Saarland's shape: the answer paper does not reprint the questions, so reading
    // only one document yields every answer and no question at all.
    const { record } = await extract({
      parliament: "saarland",
      documentType: "kleine_anfrage",
      tier: "structured",
      metadata,
      documents: [
        { role: "answer_pdf", url: "https://x.invalid/a.pdf", bytes: answerPaper, urlStable: true },
        { role: "question_pdf", url: "https://x.invalid/q.pdf", bytes: questionPaper, urlStable: true },
      ],
      env: {},
    });
    deepStrictEqual(record.qa, [
      { number: "1", question: "Erste Frage?", answer: "Erste Antwort." },
      { number: "2", question: "Zweite Frage?", answer: "Zweite Antwort." },
    ]);
    deepStrictEqual(record.extraction.abstained_fields, []);
  });

  it("does not depend on the order the documents were discovered in", async () => {
    const build = async (documents: { role: "question_pdf" | "answer_pdf"; url: string; bytes: Buffer }[]) =>
      (
        await extract({
          parliament: "saarland",
          documentType: "kleine_anfrage",
          tier: "structured",
          metadata,
          documents: documents.map((document) => ({ ...document, urlStable: true })),
          env: {},
        })
      ).record;
    const forward = await build([
      { role: "question_pdf", url: "https://x.invalid/q.pdf", bytes: questionPaper },
      { role: "answer_pdf", url: "https://x.invalid/a.pdf", bytes: answerPaper },
    ]);
    const reversed = await build([
      { role: "answer_pdf", url: "https://x.invalid/a.pdf", bytes: answerPaper },
      { role: "question_pdf", url: "https://x.invalid/q.pdf", bytes: questionPaper },
    ]);
    deepStrictEqual(forward, reversed);
  });

  it("hashes both documents into the provenance stamp", async () => {
    const { record } = await extract({
      parliament: "saarland",
      documentType: "kleine_anfrage",
      tier: "structured",
      metadata,
      documents: [
        { role: "question_pdf", url: "https://x.invalid/q.pdf", bytes: questionPaper, urlStable: true },
        { role: "answer_pdf", url: "https://x.invalid/a.pdf", bytes: answerPaper, urlStable: true },
      ],
      env: {},
    });
    // Not either document's own digest: a digest over both, so the stamp names
    // exactly the bytes the record was derived from.
    const single = record.source_documents.map((document) => document.sha256);
    ok(!single.includes(record.extraction.input_sha256));
    ok(/^[0-9a-f]{64}$/.test(record.extraction.input_sha256));
  });

  it("abstains when the merged reading fails its consistency checks", async () => {
    // A question paper numbered 1 and 2, an answer paper answering 7 and 8: the
    // merge has holes at 3..6 and must not be published.
    const { record } = await extract({
      parliament: "saarland",
      documentType: "kleine_anfrage",
      tier: "structured",
      metadata,
      documents: [
        { role: "question_pdf", url: "https://x.invalid/q.pdf", bytes: questionPaper, urlStable: true },
        {
          role: "answer_pdf",
          url: "https://x.invalid/a.pdf",
          bytes: pdf(["Zu 7.:", "Siebte Antwort.", "Zu 8.:", "Achte Antwort."]),
          urlStable: true,
        },
      ],
      env: {},
    });
    strictEqual(record.qa.length, 0);
    ok(record.extraction.abstained_fields.includes("qa"));
  });
});

describe("the tier stack", () => {
  const metadata = {
    reference: "19/10006",
    legislative_period: 19,
    title: "Wann kommen die Solaranlagen nach Pankow?",
    askers: [{ name: "Andreas Otto", party: "Grüne" }],
    answered_by: {},
    dates: { submitted: "2021-11-04", answered: "2021-11-12" },
  };
  const pdf = readFixture(
    "berlin",
    "berlin-19-10006",
    "7d0515afe6e596c8913c4353b6b89dbbb4da5c5ae4092a2cecb2a8660bf774ad.bin",
  );
  const documents = [
    {
      role: "combined_pdf" as const,
      url: "https://pardok.parlament-berlin.de/x.pdf",
      bytes: pdf,
      urlStable: true,
      retrievedAt: "2024-01-01T00:00:00Z",
    },
  ];

  it("extracts a complete record from a real document", async () => {
    const { record } = await extract({
      parliament: "berlin",
      documentType: "schriftliche_anfrage",
      tier: "structured",
      metadata,
      documents,
      env: {},
    });
    strictEqual(record.id, "berlin-19-10006");
    strictEqual(record.extraction.tier, "text_layer");
    strictEqual(record.extraction.parse_complete, true);
    strictEqual(record.extraction.review_status, "ok");
    strictEqual(record.qa.length, 6);
    match(record.answered_by.ministry ?? "", /Senatsverwaltung/);
  });

  it("is a pure function of its inputs", async () => {
    const first = await extract({ parliament: "berlin", documentType: "schriftliche_anfrage", tier: "structured", metadata, documents, env: {} });
    const second = await extract({ parliament: "berlin", documentType: "schriftliche_anfrage", tier: "structured", metadata, documents, env: {} });
    deepStrictEqual(first.record, second.record);
  });

  it("abstains instead of inventing question texts when no document was fetched", async () => {
    const { record } = await extract({
      parliament: "berlin",
      documentType: "schriftliche_anfrage",
      tier: "structured",
      metadata,
      documents: [],
      env: {},
    });
    strictEqual(record.qa.length, 0);
    strictEqual(record.extraction.tier, "structured");
    strictEqual(record.extraction.parse_complete, false);
    strictEqual(record.extraction.review_status, "needs_review");
    ok(record.extraction.abstained_fields.includes("qa"));
    ok(record.extraction.abstained_fields.includes("full_text"));
  });

  it("hashes metadata-only input independently of how the object was built", async () => {
    // `input_sha256` must identify the data, not the insertion order an adapter
    // happened to use. JSON.stringify would have given these two different digests.
    const run = async (dates: Record<string, string>) => {
      const ordered = { ...metadata, dates } as typeof metadata;
      const { record } = await extract({
        parliament: "berlin",
        documentType: "schriftliche_anfrage",
        tier: "structured",
        metadata: ordered,
        documents: [],
        env: {},
      });
      return record.extraction.input_sha256;
    };
    const submittedFirst: Record<string, string> = {};
    submittedFirst["submitted"] = "2024-03-01";
    submittedFirst["answered"] = "2024-03-28";
    const answeredFirst: Record<string, string> = {};
    answeredFirst["answered"] = "2024-03-28";
    answeredFirst["submitted"] = "2024-03-01";
    strictEqual(await run(submittedFirst), await run(answeredFirst));
  });

  it("abstains on every page in strict mode rather than running a model", async () => {
    const { record, notes } = await extract({
      parliament: "berlin",
      documentType: "schriftliche_anfrage",
      tier: "ocr",
      metadata,
      documents,
      perceiver: abstainingPerceiver,
      env: {},
    });
    ok(record.extraction.abstained_fields.includes("full_text"));
    strictEqual(record.extraction.model_artifacts.length, 0);
    ok(notes.length > 0);
  });

  it("drops a value a validator rejected instead of publishing it", async () => {
    const { record } = await extract({
      parliament: "berlin",
      documentType: "schriftliche_anfrage",
      tier: "structured",
      metadata: { ...metadata, dates: { submitted: "2021-11-12", answered: "2021-11-04" } },
      documents,
      env: {},
    });
    strictEqual(record.dates.answered, undefined);
    ok(record.extraction.abstained_fields.includes("dates.answered"));
  });
});

describe("OCR provenance", () => {
  it("refuses to describe a run whose weights it cannot hash", () => {
    // Tesseract's output depends entirely on the traineddata — two `deu` builds
    // give different text — so a record naming only the binary version claims a
    // provenance it does not have, and `ka verify` could not tell the model had
    // changed. `--ocr-traineddata` was optional, so that was the default.
    const perceiver = new TesseractCliPerceiver({ traineddataPath: "/nonexistent.traineddata" });
    throws(() => perceiver.artifact(), /Traineddata not found/);
  });

  it("hashes the weights it found into the artifact", (t) => {
    const perceiver = new TesseractCliPerceiver({ language: "eng" });
    if (!perceiver.available()) {
      t.skip("tesseract is not on PATH here");
      return;
    }
    const artifact = perceiver.artifact();
    match(artifact.version, /^tesseract-/);
    match(artifact.weights_sha256 ?? "", /^[0-9a-f]{64}$/);
  });
});
