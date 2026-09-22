// Mecklenburg-Vorpommern, driven against a recorded window of its own Parldok API.
// Tests never touch a live parliament; the fixture is a real 01.09–10.09.2026
// response, 13 combined papers, trimmed to nothing because it is already small.

import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MecklenburgVorpommernParldokSource,
  PARLDOK,
  TYPE_KLEINE_ANFRAGE_UND_ANTWORT,
  createSource,
  parseAuthors,
  splitAuthors,
  toRef,
} from "../src/index.js";
import { scriptedTransport, testEngine, fixtures } from "@maschinenlesbar.org/openka-lib-testing";

const { readFixtureText } = fixtures(import.meta.url);
const SEARCH = readFixtureText("payloads", "parldok-search.json");
const state = { source: "mecklenburg-vorpommern", http_cache: {} };

describe("MV author fields", () => {
  it("splits on the commas between entries, not the ones inside a ministry", () => {
    // Three of the four commas here belong to the ministry's name.
    deepStrictEqual(
      splitAuthors("Beate Schlupp (CDU), Landesregierung (Ministerium für Klimaschutz, Landwirtschaft, ländliche Räume und Umwelt)"),
      [
        "Beate Schlupp (CDU)",
        "Landesregierung (Ministerium für Klimaschutz, Landwirtschaft, ländliche Räume und Umwelt)",
      ],
    );
  });

  it("reads the member as an asker and the government as the answering body", () => {
    const parsed = parseAuthors("Thore Stein (AfD), Landesregierung (Ministerium für Inneres und Bau)");
    deepStrictEqual(parsed.askers, [{ name: "Thore Stein", party: "AfD" }]);
    strictEqual(parsed.ministry, "Ministerium für Inneres und Bau");
  });

  it("does not turn the government into a person", () => {
    // Reading "Landesregierung (Ministerium für …)" as a member is what produced an
    // invented political party out of half a ministry's name in Schleswig-Holstein.
    const parsed = parseAuthors("Sabine Enseleit (CDU), Landesregierung (Staatskanzlei)");
    strictEqual(parsed.askers.length, 1);
    ok(!parsed.askers.some((asker) => asker.name.includes("Landesregierung")));
    strictEqual(parsed.ministry, "Staatskanzlei");
  });

  it("falls back to the government itself when no ressort is named", () => {
    strictEqual(parseAuthors("A B (CDU), Landesregierung").ministry, "Landesregierung");
  });
});

describe("Mecklenburg-Vorpommern source", () => {
  function transport(): ReturnType<typeof scriptedTransport> {
    return scriptedTransport([{ match: "Fulltext/Search", body: SEARCH }]);
  }

  it("discovers the combined papers from the Landtag's own API", async () => {
    const { transport: scripted } = transport();
    const result = await new MecklenburgVorpommernParldokSource().discover({
      engine: testEngine(scripted),
      state,
    });
    strictEqual(result.refs.length, 13);
    for (const ref of result.refs) {
      match(ref.reference, /^8\/\d+$/);
      strictEqual(ref.documentType, "kleine_anfrage");
      // One paper holds both the question and the reply.
      deepStrictEqual(ref.documents.map((document) => document.role), ["combined_pdf"]);
      ok(ref.answered_by.ministry !== undefined, `${ref.reference} has no answering ministry`);
      ok(ref.askers.length >= 1, `${ref.reference} has no asker`);
      ok(ref.dates.answered !== undefined);
    }
  });

  it("links the PDF directly, with no viewer in between", async () => {
    const { transport: scripted } = transport();
    const result = await new MecklenburgVorpommernParldokSource().discover({
      engine: testEngine(scripted),
      state,
    });
    const url = result.refs[0]?.documents[0]?.url ?? "";
    match(url, new RegExp(`^${PARLDOK.web}/dokument/\\d+$`));
    strictEqual(result.refs[0]?.documents[0]?.urlStable, true);
  });

  it("asks for the combined paper, the Wahlperiode and the date window", async () => {
    const { transport: scripted, requests } = transport();
    await new MecklenburgVorpommernParldokSource().discover({
      engine: testEngine(scripted),
      state,
      period: 8,
      since: "2026-09-01",
      until: "2026-09-10",
    });
    const sent = requests.find((request) => request.url.includes("Fulltext/Search"));
    strictEqual(sent?.method, "POST");
    const body = JSON.parse(decodeURIComponent(String(sent?.body ?? "").replace(/^data=/, "")));
    const tags = body.tags as { type: number; id: string | number; field?: string }[];
    ok(tags.some((tag) => tag.type === 8 && tag.id === TYPE_KLEINE_ANFRAGE_UND_ANTWORT));
    ok(tags.some((tag) => tag.type === 10 && tag.id === 8));
    // The window is a server-side filter, so a sync fetches what it asked for.
    ok(tags.some((tag) => tag.type === 9 && tag.field === "datefrom" && tag.id === "01.09.2026"));
    ok(tags.some((tag) => tag.type === 9 && tag.field === "dateto" && tag.id === "10.09.2026"));
  });

  it("reports an unfamiliar response as unreadable, not as an empty Land", async () => {
    const { transport: scripted } = scriptedTransport([
      { match: "Fulltext/Search", body: "<html>Wartungsarbeiten</html>" },
    ]);
    const result = await new MecklenburgVorpommernParldokSource().discover({
      engine: testEngine(scripted),
      state,
    });
    deepStrictEqual(result.refs, []);
    ok(result.unreadable?.includes("does not know"));
  });

  it("skips a hit with no identity rather than inventing one", () => {
    const warnings: string[] = [];
    strictEqual(toRef({ title: "Ohne Nummer" }, warnings), undefined);
    strictEqual(warnings.length, 1);
  });
});

describe("what createSource returns", () => {
  it("is the Landtag's own API, with the aggregator only behind it", async () => {
    const { transport: scripted, requests } = scriptedTransport([
      { match: "Fulltext/Search", body: SEARCH },
      { match: "/suche", body: "<html>should not be reached</html>" },
    ]);
    const result = await createSource().discover({ engine: testEngine(scripted), state });
    strictEqual(result.refs.length, 13);
    // The Parlamentsspiegel is not even asked while the Land's own API answers.
    ok(!requests.some((request) => request.url.includes("parlamentsspiegel")));
    deepStrictEqual(result.warnings, []);
  });
});
