// The scraping helpers every connector shares: the XML reader, the HTML region
// helpers, and the discovery window that decides which refs a sync fetches.

import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { applyWindow, blocksWithClass, childText, decodeEntities, decodeHtml, firstHref, parseXml, parseXmlFragment, regionWithClass, spanTexts, streamElements, textOf, visibleTextOf } from "../src/index.js";
import { testEngine } from "@maschinenlesbar.org/openka-lib-testing";

describe("XML reader", () => {
  it("parses elements, attributes and text", () => {
    const node = parseXml('<a x="1"><b>hi</b></a>');
    strictEqual(node.name, "a");
    strictEqual(node.attributes["x"], "1");
    strictEqual(childText(node, "b"), "hi");
  });

  it("resolves the predefined and numeric entities and leaves unknown ones alone", () => {
    strictEqual(decodeEntities("a &amp; b &#65; &#x42; &unknown;"), "a & b A B &unknown;");
  });

  it("refuses a character reference that would produce a lone surrogate", () => {
    // Not a character: it cannot be written to XML and becomes U+FFFD as soon as
    // the string is encoded, so a feed built from it stops matching its record.
    strictEqual(decodeEntities("&#xD800;"), "&#xD800;");
    strictEqual(decodeEntities("&#55296;"), "&#55296;");
    strictEqual(decodeEntities("&#xE4;"), "ä");
  });

  it("skips comments, processing instructions and a DOCTYPE with an internal subset", () => {
    const nodes = parseXmlFragment('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY y "z">]><!-- c --><r>ok</r>');
    strictEqual(nodes.length, 1);
    strictEqual(nodes[0]?.text, "ok");
  });

  it("reads CDATA as text", () => {
    strictEqual(parseXml("<a><![CDATA[<raw> & stuff]]></a>").text, "<raw> & stuff");
  });

  it("streams sibling elements out of a large document", () => {
    const found = [...streamElements("<r><V><n>1</n></V><V><n>2</n></V></r>", "V")];
    deepStrictEqual(found.map((node) => childText(node, "n")), ["1", "2"]);
  });

  it("does not swallow the record after a self-closing element", () => {
    // `<V/>` has no `</V>`, so taking the next one consumed the element after it
    // and dropped that record entirely — silent loss in a 30k-record export.
    const found = [...streamElements("<r><V><n>1</n></V><V/><V><n>3</n></V><V><n>4</n></V></r>", "V")];
    deepStrictEqual(found.map((node) => childText(node, "n")), ["1", undefined, "3", "4"]);
  });

  it("keeps streaming when a self-closing element is the last one", () => {
    const found = [...streamElements("<r><V><n>1</n></V><V/></r>", "V")];
    strictEqual(found.length, 2);
  });

  it("ignores a stray closing tag instead of throwing away the document", () => {
    strictEqual(childText(parseXml("<a></b><c>ok</c></a>"), "c"), "ok");
  });
});

describe("HTML helpers", () => {
  it("decodes entities and strips tags", () => {
    strictEqual(textOf("<p>Br&uuml;cke <b>&amp;</b> Weg</p>"), "Brücke & Weg");
    strictEqual(decodeHtml("&#8211;"), "–");
    // A surrogate code point is not a character; the reference is left as written.
    strictEqual(decodeHtml("&#xD800;"), "&#xD800;");
  });

  it("strips every hidden element, not just the first hundred", () => {
    // The guard used to stop at 100 and return half-stripped markup, leaking the
    // hidden "Neuestes Dokument" date this function exists to remove.
    const row = (i: number) =>
      `<div class="ps-folge"><span>S ${i}</span><span class="d-none"><span>Neuestes Dokument: 2025-01-01</span></span></div>`;
    const text = visibleTextOf(Array.from({ length: 150 }, (_, i) => row(i)).join(""));
    strictEqual(text.includes("Neuestes Dokument"), false);
  });

  it("matches a class as a whole word", () => {
    const html = '<div class="ps-folge-dok">a</div><div class="ps-folge bg">b</div>';
    strictEqual(blocksWithClass(html, "ps-folge").length, 1);
  });

  it("reads a region, its spans and its first link", () => {
    const html = '<p class="ps-titel"><a href="/x"><span>Titel</span></a></p>';
    const region = regionWithClass(html, "ps-titel");
    deepStrictEqual(spanTexts(region ?? ""), ["Titel"]);
    strictEqual(firstHref(region ?? ""), "/x");
  });
});

describe("discovery windows", () => {
  const refs = [
    { key: "b", reference: "19/2", legislative_period: 19, title: "", documentType: "kleine_anfrage" as const, askers: [], answered_by: {}, dates: { answered: "2024-06-01" }, documents: [] },
    { key: "a", reference: "19/1", legislative_period: 19, title: "", documentType: "kleine_anfrage" as const, askers: [], answered_by: {}, dates: { answered: "2024-01-01" }, documents: [] },
    { key: "c", reference: "20/3", legislative_period: 20, title: "", documentType: "kleine_anfrage" as const, askers: [], answered_by: {}, dates: { answered: "2025-01-01" }, documents: [] },
  ];
  const engine = testEngine(async () => ({ status: 200, headers: {}, body: Buffer.alloc(0) }));
  const base = { engine, state: { source: "x", http_cache: {} } };

  it("filters by date and sorts by key for a stable order", () => {
    deepStrictEqual(applyWindow(refs, { ...base, since: "2024-01-01", until: "2024-12-31" }).map((ref) => ref.key), ["a", "b"]);
  });

  it("filters by legislative period", () => {
    deepStrictEqual(applyWindow(refs, { ...base, period: 20 }).map((ref) => ref.key), ["c"]);
  });

  it("applies the limit after sorting", () => {
    deepStrictEqual(applyWindow(refs, { ...base, limit: 1 }).map((ref) => ref.key), ["a"]);
  });
});
