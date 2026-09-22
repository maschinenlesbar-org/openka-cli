// The STARWEB session handshake and record extraction, against Bremen's recorded
// search form and result page — the only installation with fixtures so far.

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { actionOf, blockText, hiddenFields, noHits, pdfHref, recordBlocks, recordId, sessionFrom, totalHits } from "../src/index.js";
import { fixturesOf } from "@maschinenlesbar.org/openka-lib-testing";

const { readFixtureText } = fixturesOf("@maschinenlesbar.org/openka-connector-bremen", import.meta.url);
const FORM = readFixtureText("payloads", "paris-search-form.html");
const RESULTS = readFixtureText("payloads", "paris-results.html");

describe("the session handshake", () => {
  it("takes the session out of the search form", () => {
    const session = sessionFrom(FORM);
    ok(session !== undefined);
    // Without these two the POST is answered with the search page again, and with
    // no error — which is the worst way for this to fail.
    ok(session.fields["__websessionID"] !== undefined);
    ok(session.fields["__sessionNumber"] !== undefined);
  });

  it("reads the action number off the button instead of hard-coding it", () => {
    // The numbers are assigned per template. Bremen's search is 20; nothing
    // promises another installation agrees.
    strictEqual(actionOf(FORM, "SearchAndDisplayAction"), "20");
    strictEqual(actionOf(FORM, "SearchAction"), "19");
    strictEqual(actionOf(FORM, "NoSuchControl"), undefined);
  });

  it("has no session when the page is not a search form", () => {
    strictEqual(sessionFrom("<html><body>Wartungsarbeiten</body></html>"), undefined);
  });

  it("decodes entities in a hidden value", () => {
    deepStrictEqual(hiddenFields('<input type="hidden" name="x" value="a&amp;b" />'), { x: "a&b" });
  });
});

describe("reading a result page", () => {
  it("finds one block per hit", () => {
    strictEqual(recordBlocks(RESULTS).length, 11);
  });

  it("reports how many the search actually matched", () => {
    strictEqual(totalHits(RESULTS), 11);
  });

  it("takes the directly linked PDF and the record id", () => {
    const block = recordBlocks(RESULTS)[0] as string;
    ok(pdfHref(block)?.endsWith(".pdf"));
    ok(/^[A-Z]-\d+$/.test(recordId(block) ?? ""));
  });

  it("collapses a block to readable text", () => {
    ok(blockText(recordBlocks(RESULTS)[0] as string).includes("Kleine Anfrage"));
  });

  it("recognises the no-hits message", () => {
    ok(noHits("<p>Ihre Suche hat keine Treffer ergeben, bitte versuchen Sie es erneut.</p>"));
    ok(!noHits(RESULTS));
  });
});
