// The PARDOK `Parlamentsspiegel Export 1.0` reader, driven against a recorded
// Berlin export — the only Land that publishes the format today.

import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { parseXml } from "@maschinenlesbar.org/openka-lib-source";
import { pardokVorgangToRef, parsePardokExport } from "../src/index.js";
import { fixtures } from "@maschinenlesbar.org/openka-lib-testing";

const { readFixtureText } = fixtures(import.meta.url);

describe("Parlamentsspiegel export format", () => {
  const xml = readFixtureText("payloads", "pardok-sample.xml");

  it("turns a Schriftliche Anfrage into a DocRef", () => {
    const refs = [...parsePardokExport(xml, { herkunft: "BLN" })];
    ok(refs.length >= 1);
    const ref = refs[0];
    match(ref?.reference ?? "", /^19\/\d+$/);
    strictEqual(ref?.legislative_period, 19);
    strictEqual(ref?.documentType, "schriftliche_anfrage");
    ok((ref?.askers.length ?? 0) >= 1);
    ok(ref?.dates.submitted !== undefined);
  });

  it("emits one combined_pdf when question and answer share a URL", () => {
    const [ref] = [...parsePardokExport(xml, { herkunft: "BLN" })];
    deepStrictEqual(ref?.documents.map((document) => document.role), ["combined_pdf"]);
  });

  it("honours a deletion marker", () => {
    const deleted = `<Vorgang><VID>V-1</VID><VFunktion>delete</VFunktion>
      <Dokument><DokTyp>SchrAnfr</DokTyp><DokNr>19/1</DokNr><Wp>19</Wp></Dokument></Vorgang>`;
    strictEqual(pardokVorgangToRef(parseXml(deleted)), undefined);
  });

  it("skips a Vorgang that is not an Anfrage", () => {
    const other = `<Vorgang><VID>V-2</VID>
      <Dokument><DokTyp>VO</DokTyp><DokNr>19/2</DokNr><Wp>19</Wp></Dokument></Vorgang>`;
    strictEqual(pardokVorgangToRef(parseXml(other)), undefined);
  });

  it("namespaces the discovery key by the field it came from", () => {
    const doc = `<Dokument><DokTyp>SchrAnfr</DokTyp><DokNr>19/1234</DokNr><Wp>19</Wp></Dokument>`;
    const keyOf = (head: string): string | undefined =>
      pardokVorgangToRef(parseXml(`<Vorgang>${head}${doc}</Vorgang>`))?.key;

    strictEqual(keyOf("<VID>1234</VID><VNr>7</VNr>"), "VID:1234");
    strictEqual(keyOf("<VNr>1234</VNr>"), "VNr:1234");
    strictEqual(keyOf(""), "ref:19/1234");
    // Unprefixed these three were the same string, so a Vorgang identified by its
    // VNr shadowed an unrelated one whose VID happened to carry the same digits.
    strictEqual(new Set([keyOf("<VID>1234</VID>"), keyOf("<VNr>1234</VNr>"), keyOf("")]).size, 3);
  });

  it("filters by Herkunft so an aggregated feed yields one Land", () => {
    strictEqual([...parsePardokExport(xml, { herkunft: "XX" })].length, 0);
  });
});
