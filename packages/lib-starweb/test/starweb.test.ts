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

describe("a result page whose tags never close (security audit 2026-10-27)", () => {
  // `<input\b[^>]*>`, `<tbody\b[^>]*name="RecordRepeater"[^>]*>([\s\S]*?)</tbody\s*>` and
  // `<[^>]+>` ran from every tag start to the end of a page that never closes its tags:
  // 60 KB took a second for each, and `<tbody name="RecordRepeater" ` repeated minutes.
  const SIZE = 150_000;
  const repeat = (unit: string): string => unit.repeat(Math.ceil(SIZE / unit.length));
  const fast = (label: string, work: () => unknown): void => {
    const started = performance.now();
    work();
    const took = performance.now() - started;
    ok(took < 500, `${label} took ${Math.round(took)} ms`);
  };
  for (const unit of ["<input ", "<tbody ", '<tbody name="RecordRepeater" ', '<tbody name="RecordRepeater">', "<", '<input value="<x" ']) {
    it(`reads ${JSON.stringify(unit)} repeated in linear time`, () => {
      const page = repeat(unit);
      fast("hiddenFields", () => hiddenFields(page));
      fast("recordBlocks", () => recordBlocks(page));
      fast("blockText", () => blockText(page));
    });
  }

  it("still reads hidden inputs (a quoted > now whole), record blocks and their text", () => {
    deepStrictEqual(hiddenFields('<INPUT type="hidden" name="a" value="1&amp;2"><input type=hidden name="b" value="x>y"><input name="c" value="3">'), { a: "1&2", b: "x>y" });
    deepStrictEqual(recordBlocks('<tbody class="x" NAME="RecordRepeater" id="1">A</tbody ><tbody>B</tbody><tbody name="RecordRepeater">C</TBODY><tbody name="RecordRepeater">D'), ["A", "C"]);
    strictEqual(blockText("a<b>b</b> <> c &amp; <i"), "a b <> c & <i");
  });
});
