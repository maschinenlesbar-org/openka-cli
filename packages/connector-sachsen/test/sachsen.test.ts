// Sachsen: the documents were not where the aggregator said they were.
//
// It spent a classification pass looking like a source of scanned PDFs. It is not:
// what we were storing and failing to read was a frameset viewer. These tests pin
// the resolution down so that mistake cannot come back quietly.

import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SachsenSource,
  mergeDuplicates,
  sachsenNavigationUrl,
  sachsenPdfUrlFrom,
  sachsenPositionUrl,
  sachsenPositions,
} from "../src/index.js";
import type { DocRefDocument } from "@maschinenlesbar.org/openka-lib-source";
import { scriptedTransport, testEngine, fixtures, fixturesOf } from "@maschinenlesbar.org/openka-lib-testing";

const { readFixtureText } = fixtures(import.meta.url);
// The result row that names the viewer is the aggregator's document, not Sachsen's.
const ps = fixturesOf("@maschinenlesbar.org/openka-lib-parlamentsspiegel", import.meta.url);

describe("Sachsen document resolution", () => {
  const NAV = readFixtureText("payloads", "edas-viewer-navigation.html");

  it("builds the viewer's navigation URL, keeping the query", () => {
    strictEqual(
      sachsenNavigationUrl("https://edas.landtag.sachsen.de/viewer.aspx?dok_art=Drs&dok_nr=3284&leg_per=8"),
      "https://edas.landtag.sachsen.de/viewer/viewer_navigation.aspx?dok_art=Drs&dok_nr=3284&leg_per=8",
    );
  });

  it("declines a URL that is not an EDAS viewer link", () => {
    strictEqual(sachsenNavigationUrl("https://example.invalid/viewer.aspx?x=1"), undefined);
    strictEqual(sachsenNavigationUrl("not a url"), undefined);
  });

  it("reads the document link out of the navigation frame", () => {
    // The link sits inside a JavaScript call with HTML-escaped quotes.
    strictEqual(sachsenPdfUrlFrom(NAV), "https://ws.landtag.sachsen.de/images/8_Drs_3284_0_1_1_.pdf");
  });

  it("reports rather than invents when the page names no document", () => {
    strictEqual(sachsenPdfUrlFrom("<html><body>nichts</body></html>"), undefined);
  });

  it("enumerates the document positions the viewer lists", () => {
    // EDAS answers an unrefined query with "Mehrere Dokumente gefunden, bitte
    // verfeinern" and shows only the first; the buttons are how it names the rest.
    deepStrictEqual(sachsenPositions(NAV), [0, 1]);
    deepStrictEqual(sachsenPositions("<html>no buttons</html>"), []);
  });

  it("refines the navigation URL to one position", () => {
    const refined = sachsenPositionUrl(
      "https://edas.landtag.sachsen.de/viewer/viewer_navigation.aspx?dok_art=Drs&dok_nr=3284&leg_per=8",
      1,
    );
    match(refined, /pos_dok=1/);
    match(refined, /dok_id=0/);
    match(refined, /dok_nr=3284/);
  });

  it("resolves both positions and gives them their roles", async () => {
    const { transport } = scriptedTransport([
      { match: "/suche", body: ps.readFixtureText("payloads", "parlamentsspiegel-sachsen.html") },
      { match: "pos_dok=1", body: readFixtureText("payloads", "edas-viewer-navigation-pos1.html") },
      { match: "viewer_navigation.aspx", body: NAV },
    ]);
    const result = await new SachsenSource().discover({
      engine: testEngine(transport),
      state: { source: "sachsen", http_cache: {} },
    });
    const ref = result.refs[0];
    deepStrictEqual(ref?.documents.map((document) => document.role), ["question_pdf", "answer_pdf"]);
    match(ref?.documents[0]?.url ?? "", /_0_1_1_\.pdf$/);
    match(ref?.documents[1]?.url ?? "", /_1_1_1_\.pdf$/);
  });

  it("resolves discovered documents to the static file", async () => {
    const { transport } = scriptedTransport([
      { match: "/suche", body: ps.readFixtureText("payloads", "parlamentsspiegel-sachsen.html") },
      { match: "viewer_navigation.aspx", body: NAV },
    ]);
    const result = await new SachsenSource().discover({
      engine: testEngine(transport),
      state: { source: "sachsen", http_cache: {} },
    });
    ok(result.refs.length >= 1);
    for (const ref of result.refs) {
      for (const document of ref.documents) {
        match(document.url, /^https:\/\/ws\.landtag\.sachsen\.de\/images\/.*\.pdf$/);
        // The resolved file is a plain static document, unlike the viewer link.
        strictEqual(document.urlStable, true);
      }
    }
  });

  it("keeps the viewer link and warns when resolution fails", async () => {
    const { transport } = scriptedTransport([
      { match: "/suche", body: ps.readFixtureText("payloads", "parlamentsspiegel-sachsen.html") },
      { match: "viewer_navigation.aspx", body: "<html>nichts</html>" },
    ]);
    const result = await new SachsenSource().discover({
      engine: testEngine(transport),
      state: { source: "sachsen", http_cache: {} },
    });
    ok(result.warnings.some((warning) => warning.includes("named no document")));
    match(result.refs[0]?.documents[0]?.url ?? "", /viewer\.aspx/);
  });

  it("merges a question and an answer that are the same file into one document", () => {
    const documents: DocRefDocument[] = [
      { role: "question_pdf", url: "https://x.invalid/a.pdf", urlStable: true },
      { role: "answer_pdf", url: "https://x.invalid/a.pdf", urlStable: true },
    ];
    deepStrictEqual(mergeDuplicates(documents), [
      { role: "combined_pdf", url: "https://x.invalid/a.pdf", urlStable: true },
    ]);
  });

  it("leaves genuinely separate documents alone", () => {
    const documents: DocRefDocument[] = [
      { role: "question_pdf", url: "https://x.invalid/q.pdf", urlStable: true },
      { role: "answer_pdf", url: "https://x.invalid/a.pdf", urlStable: true },
    ];
    strictEqual(mergeDuplicates(documents).length, 2);
  });

});
