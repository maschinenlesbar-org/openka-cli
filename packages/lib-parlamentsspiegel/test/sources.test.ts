import { deepStrictEqual, match, ok, rejects, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { blocksWithClass } from "@maschinenlesbar.org/openka-lib-source";
import { FIRST_PAGE, MAX_PAGES, ParlamentsspiegelSource, documentRole, parseResultCount, parseVorgangBlock, toGermanDate, ParlamentsspiegelAllLaender, undecorated } from "../src/index.js";
import { UsageError } from "@maschinenlesbar.org/openka-lib-errors";
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
    // Finding 01#11: without the "(8. Wp), TMUENF" the portal appends.
    deepStrictEqual(ministryOf("parlamentsspiegel-thueringen.html").sort(), [
      "Ministerium für Inneres, Kommunales und Landesentwicklung",
      "Ministerium für Umwelt, Energie, Naturschutz und Forsten",
    ]);
    strictEqual(undecorated("Ministerium für Bildung (7. Wp.), TMBJS"), "Ministerium für Bildung");
    strictEqual(undecorated("MUNV"), "MUNV");
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

  it("reads the recorded Sachsen-Anhalt rows: SACA, the Drucksache, the askers, the document under /files/", async () => {
    const page = readFixtureText("payloads", "parlamentsspiegel-sachsen-anhalt.html");
    const { transport } = scriptedTransport([{ match: "page=0", body: page }, { match: "/suche", body: "<html></html>" }]);
    const result = await new ParlamentsspiegelSource("sachsen-anhalt").discover({
      engine: testEngine(transport),
      state: { source: "sachsen-anhalt", http_cache: {} },
    });
    deepStrictEqual(result.refs.map((ref) => [ref.reference, ref.parliament]), [
      ["08/4004", "sachsen-anhalt"],
      ["08/4010", "sachsen-anhalt"],
      ["08/4011", "sachsen-anhalt"],
    ]);
    const greens = result.refs.find((ref) => ref.reference === "08/4011");
    deepStrictEqual(greens?.askers.map((asker) => asker.name), ["Olaf Meister", "Wolfgang Aldag"]);
    match(greens?.documents[0]?.url ?? "", /^https:\/\/padoka\.landtag\.sachsen-anhalt\.de\/files\/drs\//);
  });

  it("leaves out rows of other Länder when pinned to one, and says so", async () => {
    // The search is pinned with qyHerk, but each row names its own Land. Rows of
    // another Land were stored under the pinned source's run and counted as its own.
    const nrwOnly = readFixtureText("payloads", "parlamentsspiegel-results.html");
    const { transport } = scriptedTransport([{ match: "page=0", body: nrwOnly }, { match: "/suche", body: "<html></html>" }]);
    const result = await new ParlamentsspiegelSource("sachsen-anhalt").discover({
      engine: testEngine(transport),
      state: { source: "sachsen-anhalt", http_cache: {} },
    });
    deepStrictEqual(result.refs, []);
    ok(result.warnings.some((warning) => /returned \d+ row\(s\) of other Länder \(nordrhein-westfalen \d+\)/.test(warning)));
    // The all-Länder source keeps them: it is not pinned.
    const all = await new ParlamentsspiegelAllLaender().discover({
      engine: testEngine(scriptedTransport([{ match: "page=0", body: nrwOnly }, { match: "/suche", body: "<html></html>" }]).transport),
      state: { source: "parlamentsspiegel", http_cache: {} },
    });
    ok(all.refs.length > 0);
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

// Recorded from the live portal on 2026-10-05 (review result 05) and trimmed to the
// rows that showed the bugs: Hessen's Greens lost their party into their name,
// Baden-Württemberg's "Staatsministerium" became an asker, Sachsen's askers kept
// their party inside the name, and Bayern dropped an asker with a "(FH)" degree.
describe("askers and answering bodies as the Länder print them", () => {
  const refsOf = (payload: string) =>
    blocksWithClass(readFixtureText("payloads", payload), "ps-vorgang", /<hr\s*\/?>/).map((block) => parseVorgangBlock(block, []));

  it("reads Hessen's trailing BÜNDNIS 90/DIE GRÜNEN as the party (finding 05#1)", () => {
    const refs = refsOf("parlamentsspiegel-hessen.html");
    deepStrictEqual(refs.map((ref) => ref?.askers), [
      [{ name: "Maximilian Müger", party: "fraktionslos" }],
      [
        { name: "Dr. Stefan Naas", party: "Freie Demokraten" },
        { name: "Marion Schardt-Sauer", party: "Freie Demokraten" },
      ],
      [
        { name: "Sascha Meier", party: "BÜNDNIS 90/DIE GRÜNEN" },
        { name: "Lara Klaes", party: "BÜNDNIS 90/DIE GRÜNEN" },
      ],
    ]);
  });

  it("files Baden-Württemberg's Staatsministerium as the answering body, not an asker (finding 05#2)", () => {
    const refs = refsOf("parlamentsspiegel-baden-wuerttemberg.html");
    deepStrictEqual(refs.map((ref) => [ref?.reference, ref?.askers, ref?.answered_by]), [
      ["18/447", [{ name: "Christian Schäfer", party: "AfD" }], { ministry: "Staatsministerium" }],
      ["18/430", [{ name: "Emil Sänze", party: "AfD" }], { ministry: "Staatsministerium" }],
    ]);
  });

  it("splits Sachsen's 'Given Surname Party' form on a known party (finding 01#3)", () => {
    deepStrictEqual(refsOf("parlamentsspiegel-sachsen.html").map((ref) => ref?.askers), [
      [{ name: "Juliane Nagel", party: "Die Linke" }],
      [{ name: "Juliane Nagel", party: "Die Linke" }],
    ]);
  });

  it("keeps Bayern's asker with a '(FH)' degree", () => {
    const winhart = refsOf("parlamentsspiegel-bayern.html").find((ref) => ref?.reference === "19/13262");
    deepStrictEqual(winhart?.askers, [
      { name: "Dipl.-Betriebswirt (FH) Andreas Winhart", party: "AfD" },
      { name: "Franz Bergmüller", party: "AfD" },
    ]);
  });
});

// Finding 01#2: Bayern's row date is the paper's, months after the question.
describe("a Bayern row", () => {
  it("is the combined paper, dated as the answer", () => {
    const refs = blocksWithClass(readFixtureText("payloads", "parlamentsspiegel-bayern.html"), "ps-vorgang", /<hr\s*\/?>/).map((block) =>
      parseVorgangBlock(block, []),
    );
    for (const ref of refs) {
      deepStrictEqual(ref?.documents.map((document) => document.role), ["combined_pdf"]);
      strictEqual(ref?.dates.submitted, undefined);
      ok(ref?.dates.answered !== undefined);
    }
    deepStrictEqual(refs.find((ref) => ref?.reference === "19/13269")?.dates, { answered: "2026-09-14" });
  });
});

describe("counting the portal (issue #5)", () => {
  const countPage = readFixtureText("payloads", "parlamentsspiegel-count.html");

  it("reads the result count a search page prints, thousands separators and all", () => {
    strictEqual(parseResultCount(countPage), 69935);
    strictEqual(parseResultCount("<p>nothing here</p>"), undefined);
  });

  it("asks one smallest first page with the filters discovery uses, for one Land or all", async () => {
    const { transport, requests } = scriptedTransport([{ match: "/suche", body: countPage }]);
    deepStrictEqual(await new ParlamentsspiegelSource("berlin").count({ engine: testEngine(transport) }), { total: 69935, basis: "Parlamentsspiegel" });
    await new ParlamentsspiegelAllLaender().count({ engine: testEngine(transport) });
    strictEqual(requests.length, 2);
    const [land, all] = requests.map((request) => new URL(request.url).searchParams);
    deepStrictEqual(
      [land?.get("qyHerk"), land?.get("fqDTyp"), land?.get("qyVTyp"), land?.get("page"), land?.get("size")],
      ["BLN", "KlAnfr", "Anfrage", "0", "5"],
    );
    strictEqual(all?.get("qyHerk"), null);
  });

  it("refuses a Wahlperiode it cannot filter by, and a page without a count", async () => {
    const { transport, requests } = scriptedTransport([{ match: "/suche", body: "<html><body>redesigned</body></html>" }]);
    await rejects(new ParlamentsspiegelSource("berlin").count({ engine: testEngine(transport), period: 19 }), UsageError);
    strictEqual(requests.length, 0, "refused before asking");
    await rejects(new ParlamentsspiegelSource("berlin").count({ engine: testEngine(transport) }), /printed no result count/);
  });
});

describe("paging the portal", () => {
  it("starts at the first page, page=0, so a window of one page is not empty", async () => {
    // The portal counts pages from 0. A discovery that began at page=1 skipped the
    // newest 50 results, and Saarland's September 2026 — 15 Anfragen — found none.
    const html = readFixtureText("payloads", "parlamentsspiegel-results.html");
    const { transport, requests } = scriptedTransport([
      { match: /[?&]page=0(&|$)/, body: html },
      { match: "/suche", body: "<html><body></body></html>" },
    ]);
    const result = await new ParlamentsspiegelSource("nordrhein-westfalen").discover({
      engine: testEngine(transport),
      state: { source: "nordrhein-westfalen", http_cache: {} },
    });
    strictEqual(FIRST_PAGE, 0);
    ok(result.refs.length > 0, "the first page's results are found");
    deepStrictEqual(requests.map((request) => new URL(request.url).searchParams.get("page")), ["0", "1"]);
    ok(!result.warnings.some((warning) => warning.includes("discovery stopped after")));
  });

  it("says so when it stops at the page cap with more left", async () => {
    // Sachsen-Anhalt holds ~20,000 Kleine Anfragen; one walk reads 5,000 and used to
    // report them as the whole window.
    const sa = readFixtureText("payloads", "parlamentsspiegel-sachsen-anhalt.html");
    const first = blocksWithClass(sa, "ps-vorgang", /<hr\s*\/?>/)[0] as string;
    const row = (n: number): string =>
      first.replace(/SACA_V\d+/g, `SACA_V${n}`).replace(/_D\d+/g, `_D${n}`).replace(/0?8\/4004/g, `08/${n}`);
    let requests = 0;
    const transport = async (request: { url: string }): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> => {
      requests++;
      const page = Number(new URL(request.url).searchParams.get("page"));
      const rows = Array.from({ length: 50 }, (_, i) => row(100000 + page * 50 + i)).join("\n");
      return { status: 200, headers: {}, body: Buffer.from(`<html><body>${rows}</body></html>`) };
    };
    const result = await new ParlamentsspiegelSource("sachsen-anhalt").discover({
      engine: testEngine(transport),
      state: { source: "sachsen-anhalt", http_cache: {} },
    });
    strictEqual(requests, MAX_PAGES);
    strictEqual(result.refs.length, MAX_PAGES * 50);
    ok(result.warnings.some((warning) => warning.includes(`discovery stopped after ${MAX_PAGES} pages`) && warning.includes("--since/--until")));
  });
});

// Issue #20: the portal glues two document URLs into one href for some
// Sachsen-Anhalt papers — `…/d7036dak.pdfhttps://…/d7036dak.doc` — and that string
// was fetched as one URL, answered 404, and the record was stored without a document.
describe("a document link holding several URLs", () => {
  const BASE = "https://padoka.landtag.sachsen-anhalt.de/files/drs/wp8/drs";
  const recorded = (): string => blocksWithClass(readFixtureText("payloads", "parlamentsspiegel-glued-href.html"), "ps-vorgang", /<hr\s*\/?>/)[0] as string;

  it("takes the PDF of the recorded row 08/7036 and names what it left out", () => {
    const warnings: string[] = [];
    const ref = parseVorgangBlock(recorded(), warnings);
    deepStrictEqual(ref?.documents.map((document) => document.url), [`${BASE}/d7036dak.pdf`]);
    deepStrictEqual(warnings, [
      `08/7036: the portal's document link holds 2 URLs glued together (${BASE}/d7036dak.pdf${BASE}/d7036dak.doc); ` +
        `took ${BASE}/d7036dak.pdf and left out ${BASE}/d7036dak.doc`,
    ]);
  });

  it("prefers the PDF wherever it sits, and the first of two PDFs", () => {
    const withHref = (href: string): string => recorded().replace(`${BASE}/d7036dak.pdf${BASE}/d7036dak.doc`, href);
    for (const [href, expected] of [
      [`${BASE}/d7230dak.doc${BASE}/d7230dak.pdf`, `${BASE}/d7230dak.pdf`],
      [`${BASE}/d6426gak.pdf${BASE}/d6426dak.pdf`, `${BASE}/d6426gak.pdf`],
      [`${BASE}/d1dak.doc${BASE}/d1dak.docx`, `${BASE}/d1dak.doc`],
      [`${BASE}/d7036dak.pdf`, `${BASE}/d7036dak.pdf`],
    ] as const) {
      const warnings: string[] = [];
      deepStrictEqual(parseVorgangBlock(withHref(href), warnings)?.documents.map((document) => document.url), [expected], href);
      strictEqual(warnings.length, href.lastIndexOf("https://") > 0 ? 1 : 0, href);
    }
  });

  it("splits an answer's link the same way", () => {
    // No recorded Sachsen-Anhalt row has an answer link yet; Niedersachsen's do.
    const html = readFixtureText("payloads", "parlamentsspiegel-niedersachsen.html");
    const block = blocksWithClass(html, "ps-vorgang", /<hr\s*\/?>/).find((candidate) => {
      const ref = parseVorgangBlock(candidate, []);
      return ref?.documents.some((document) => document.role === "answer_pdf") === true;
    });
    ok(block !== undefined, "the recorded page has a row with an answer");
    const answer = parseVorgangBlock(block, [])?.documents.find((document) => document.role === "answer_pdf")?.url as string;
    const glued = block.replace(`href="${answer}"`, `href="${answer.replace(/\.pdf$/, ".doc")}${answer}"`);
    const warnings: string[] = [];
    deepStrictEqual(parseVorgangBlock(glued, warnings)?.documents.find((document) => document.role === "answer_pdf")?.url, answer);
    match(warnings.join("\n"), /document link holds 2 URLs glued together/);
  });
});

// Issue #22: Sachsen-Anhalt's combined papers carry no question date in the row.
describe("a Sachsen-Anhalt combined paper", () => {
  it("is dated by the answer, and the Nachtrag's second date is not taken for the question's", () => {
    // Recorded 2026-10-08 (qyHerk=SACA, 2025): 8/6424 prints one date; 8/6307 prints
    // "03.12.2025, 10.12.2025 … (Nachtrag 10.12.2025)" — the paper's and its Nachtrag's.
    const html = readFixtureText("payloads", "parlamentsspiegel-sachsen-anhalt-combined.html");
    const refs = blocksWithClass(html, "ps-vorgang", /<hr\s*\/?>/).map((block) => parseVorgangBlock(block, []));
    deepStrictEqual(
      refs.map((ref) => [ref?.reference, ref?.documents[0]?.role, ref?.dates]),
      [
        ["08/6424", "combined_pdf", { answered: "2025-12-22" }],
        ["08/6307", "combined_pdf", { answered: "2025-12-10" }],
      ],
    );
  });
});
