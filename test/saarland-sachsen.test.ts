// Saarland and Sachsen: two Länder whose documents were not where the aggregator
// said they were.
//
// Both spent a classification pass looking like sources of scanned PDFs. Neither
// is: what we were storing and failing to read was an HTML wrapper in one case and
// a frameset viewer in the other. These tests pin the resolution down so that
// mistake cannot come back quietly.

import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { SaarlandSource, saarlandDocumentUrl } from "../src/sources/saarland.js";
import {
  SachsenSource,
  mergeDuplicates,
  sachsenNavigationUrl,
  sachsenPdfUrlFrom,
  sachsenPositionUrl,
  sachsenPositions,
} from "../src/sources/sachsen.js";
import { sourceEntry } from "../src/sources/registry.js";
import type { DocRefDocument } from "../src/sources/base.js";
import { readFixtureText, scriptedTransport, testEngine } from "./helpers.js";

describe("Saarland document URLs", () => {
  it("unwraps the iframe page the aggregator links to", () => {
    strictEqual(
      saarlandDocumentUrl("http://landtag-saar.de/Drucksache/Af17_1326.pdf"),
      "https://www.landtag-saar.de/Downloadfile.ashx?FileId=-1&FileName=Af17_1326.pdf",
    );
    // The same page is served from the www host too.
    ok(saarlandDocumentUrl("https://www.landtag-saar.de/Drucksache/Aw17_1407.pdf") !== undefined);
  });

  it("leaves a URL that is not a wrapper exactly as it is", () => {
    strictEqual(saarlandDocumentUrl("https://www.landtag-saar.de/Downloadfile.ashx?FileName=x.pdf"), undefined);
    strictEqual(saarlandDocumentUrl("https://example.invalid/other.pdf"), undefined);
  });

  it("rewrites every document of every discovered ref", async () => {
    const { transport } = scriptedTransport([
      { match: "/suche", body: readFixtureText("payloads", "parlamentsspiegel-saarland.html") },
    ]);
    const result = await new SaarlandSource().discover({
      engine: testEngine(transport),
      state: { source: "saarland", http_cache: {} },
    });
    ok(result.refs.length >= 1);
    for (const ref of result.refs) {
      for (const document of ref.documents) {
        match(document.url, /Downloadfile\.ashx\?FileId=-1&FileName=[A-Za-z0-9_.-]+\.pdf$/);
        strictEqual(document.urlStable, true);
      }
    }
  });

  it("is registered as its own source", () => {
    strictEqual(sourceEntry("saarland")?.status, "implemented");
  });
});

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
      { match: "/suche", body: readFixtureText("payloads", "parlamentsspiegel-sachsen.html") },
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
      { match: "/suche", body: readFixtureText("payloads", "parlamentsspiegel-sachsen.html") },
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
      { match: "/suche", body: readFixtureText("payloads", "parlamentsspiegel-sachsen.html") },
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

  it("is registered as its own source", () => {
    strictEqual(sourceEntry("sachsen")?.status, "implemented");
  });
});
