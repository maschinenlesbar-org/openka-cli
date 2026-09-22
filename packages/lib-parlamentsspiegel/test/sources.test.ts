import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { blocksWithClass } from "@maschinenlesbar.org/openka-lib-source";
import { ParlamentsspiegelSource, documentRole, parseVorgangBlock, toGermanDate, ParlamentsspiegelAllLaender } from "../src/index.js";
import { MemoryStore, scriptedTransport, testEngine, fixtures } from "@maschinenlesbar.org/openka-lib-testing";

const { readFixtureText } = fixtures(import.meta.url);

describe("Parlamentsspiegel source", () => {
  const html = readFixtureText("payloads", "parlamentsspiegel-results.html");

  it("converts an ISO date to the form the search form wants", () => {
    strictEqual(toGermanDate("2024-03-01"), "01.03.2024");
  });

  it("parses a result block into a DocRef with its own parliament", () => {
    const blocks = blocksWithClass(html, "ps-vorgang", /<hr\s*\/?>/);
    ok(blocks.length >= 1);
    const warnings: string[] = [];
    const ref = parseVorgangBlock(blocks[0] as string, warnings);
    strictEqual(ref?.parliament, "nordrhein-westfalen");
    match(ref?.reference ?? "", /^\d{2}\/\d+$/);
    strictEqual(ref?.documentType, "kleine_anfrage");
    ok((ref?.title.length ?? 0) > 10);
    ok(ref?.documents.some((document) => document.role === "question_pdf"));
  });

  it("picks up the Antwort from the follow-up documents", () => {
    const blocks = blocksWithClass(html, "ps-vorgang", /<hr\s*\/?>/);
    const refs = blocks.map((block) => parseVorgangBlock(block, [])).filter(Boolean);
    const answered = refs.find((ref) => ref?.documents.some((document) => document.role === "answer_pdf"));
    ok(answered !== undefined, "expected at least one result with an answer document");
    ok(answered?.dates.answered !== undefined);
    ok(answered?.answered_by.ministry !== undefined);
  });

  it("reads a follow-up the portal did not collapse", () => {
    // The portal only puts the `ps-folge` class on the wrapper when the search
    // filtered some of a Vorgang's follow-ups away. A row reading
    // "0 gefiltert/ausgeblendet" renders the same markup under a bare `<div >`,
    // and splitting on `ps-folge` lost its answer entirely — which is every
    // Niedersachsen and Thüringen row in the recorded payloads.
    for (const payload of ["parlamentsspiegel-niedersachsen.html", "parlamentsspiegel-thueringen.html"]) {
      const blocks = blocksWithClass(readFixtureText("payloads", payload), "ps-vorgang", /<hr\s*\/?>/);
      const refs = blocks.map((block) => parseVorgangBlock(block, []));
      ok(refs.length >= 1);
      for (const ref of refs) {
        ok(ref?.documents.some((document) => document.role === "answer_pdf"), `${payload}: no answer document`);
        ok(ref?.dates.answered !== undefined, `${payload}: no answer date`);
        ok(ref?.answered_by.ministry !== undefined, `${payload}: no answering body`);
      }
    }
  });

  it("takes the answering body from the follow-up's own Urheber field", () => {
    const ministryOf = (payload: string): (string | undefined)[] =>
      blocksWithClass(readFixtureText("payloads", payload), "ps-vorgang", /<hr\s*\/?>/)
        .map((block) => parseVorgangBlock(block, [])?.answered_by.ministry);

    // Reading it out of the summary line instead meant guessing where the name
    // began. Thüringen writes "Antwort auf Kleine Anfrage. Ministerium für …",
    // whose leading clause is not part of the name, and Sachsen writes
    // "Antw SMI 12.08.2025 Drs 8/3351", which has no delimiter to stop at.
    deepStrictEqual(ministryOf("parlamentsspiegel-sachsen.html"), ["SMI", "SMI"]);
    for (const ministry of ministryOf("parlamentsspiegel-thueringen.html")) {
      match(ministry ?? "", /^Ministerium für /);
    }
    // Unchanged where the old reading already worked.
    deepStrictEqual(ministryOf("parlamentsspiegel-saarland.html"), ["Landesregierung", "Landesregierung"]);
    deepStrictEqual(ministryOf("parlamentsspiegel-nrw.html"), ["MUNV", "MUNV", "MUNV"]);
  });

  it("accepts the word Thüringen uses for a paper", () => {
    // Most Länder label it "Drucksache"; Thüringen labels the same thing
    // "Dokument", and requiring the commoner word cost that Land every record.
    const row = (label: string): string =>
      `<div class="ps-vorgang"><p class="ps-titel"><a class="ps-details" href=".ps-detail-THUE_V1_D2"><span>T</span></a></p>` +
      `<p class="ps-dokument"><div><a href="https://example.invalid/a.pdf"><span>${label} 08/3102</span></a>` +
      `<span>Thüringen - Kleine Anfrage; AfD; 09.09.2026; (2 S.)</span></div></p></div>`;
    strictEqual(parseVorgangBlock(row("Drucksache"), [])?.reference, "08/3102");
    strictEqual(parseVorgangBlock(row("Dokument"), [])?.reference, "08/3102");
  });

  it("reports rather than guesses when the markup yields nothing", async () => {
    const { transport } = scriptedTransport([{ match: "/suche", body: "<html><body>redesigned</body></html>" }]);
    const result = await new ParlamentsspiegelAllLaender().discover({
      engine: testEngine(transport),
      state: { source: "parlamentsspiegel", http_cache: {} },
    });
    deepStrictEqual(result.refs, []);
    ok(result.warnings[0]?.includes("markup changed"));
  });

  it("pins itself to one Land's Herkunft code when constructed with a parliament", async () => {
    const { transport, requests } = scriptedTransport([{ match: "/suche", body: html }]);
    await new ParlamentsspiegelSource("hamburg").discover({
      engine: testEngine(transport),
      state: { source: "x", http_cache: {} },
      limit: 1,
    });
    match(requests[0]?.url ?? "", /qyHerk=HH/);
  });
});

describe("document roles in a result row", () => {
  it("reads a combined paper from the Fundstelle", () => {
    // Schleswig-Holstein files the Vorgang under "Antwort" but publishes the Kleine
    // Anfrage and the reply as one Drucksache; the Fundstelle is what says so.
    strictEqual(
      documentRole(
        "Drucksache 20/3331 : Schleswig-Holstein - Antwort; Abgeordnete/r: SPD, Landesregierung; 26.06.2025",
        "Schleswig-Holstein - Kleine Anfrage Birte Pauls (SPD) und Antwort MSJFSIG 26.06.2025 Drucksache 20/3331",
      ),
      "combined_pdf",
    );
  });

  it("reads a question row as a question", () => {
    strictEqual(
      documentRole("Nordrhein-Westfalen - Kleine Anfrage; Abgeordnete/r: FDP; 17.09.2026", "… Kleine Anfrage 8783 …"),
      "question_pdf",
    );
  });

  it("reads an answer-only row as an answer", () => {
    strictEqual(documentRole("Brandenburg - Antwort (Ministerium des Innern) 18.07.2025", "Brandenburg - Antwort …"), "answer_pdf");
  });

  it("parses Schleswig-Holstein rows as combined documents dated by the answer", () => {
    const html = readFixtureText("payloads", "parlamentsspiegel-sh.html");
    const blocks = blocksWithClass(html, "ps-vorgang", /<hr\s*\/?>/);
    ok(blocks.length >= 1);
    for (const block of blocks) {
      const ref = parseVorgangBlock(block, []);
      strictEqual(ref?.parliament, "schleswig-holstein");
      deepStrictEqual(ref?.documents.map((document) => document.role), ["combined_pdf"]);
      // The one printed date is when the combined paper appeared. The question's own
      // date is not in the row, and a guessed one would be worse than none.
      ok(ref?.dates.answered !== undefined);
      strictEqual(ref?.dates.submitted, undefined);
    }
  });
});

describe("the memory store used by these tests", () => {
  it("behaves like the real one for blobs and records", () => {
    const store = new MemoryStore();
    const digest = store.putBlob(Buffer.from("x"));
    ok(store.hasBlob(digest));
    strictEqual(store.recordIds().length, 0);
  });
});
