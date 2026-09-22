// Saarland: the documents were not where the aggregator said they were.
//
// It spent a classification pass looking like a source of scanned PDFs. It is not:
// what we were storing and failing to read was an HTML wrapper. These tests pin the
// resolution down so that mistake cannot come back quietly.

import { match, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { SaarlandSource, saarlandDocumentUrl } from "../src/index.js";
import { scriptedTransport, testEngine, fixturesOf } from "@maschinenlesbar.org/openka-lib-testing";

const { readFixtureText } = fixturesOf("@maschinenlesbar.org/openka-lib-parlamentsspiegel", import.meta.url);

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

});
