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
import type { Transport } from "@maschinenlesbar.org/openka-lib-http";

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

  it("reads the Ministerpräsident(in) as the answering body, never as an asker", () => {
    // "Minister\b" does not match inside "Ministerpräsidentin", so the head of
    // government was stored as a second person who asked.
    for (const office of ["Ministerpräsidentin", "Ministerpräsident"]) {
      const parsed = parseAuthors(`Martin Schmidt (AfD), ${office}`);
      deepStrictEqual(parsed.askers, [{ name: "Martin Schmidt", party: "AfD" }], office);
      strictEqual(parsed.ministry, office);
    }
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


  it("pages through a listing longer than one page", async () => {
    // One page carries at most 200 hits and the count says how many there are.
    // Asking once and stopping turned a Wahlperiode of 2 000 Kleine Anfragen into
    // exactly 200 with no sign of the rest.
    const first = JSON.parse(SEARCH) as { data: string };
    const inner = JSON.parse(first.data) as { count: number; docs: Record<string, unknown>[] };
    const total = inner.docs.length * 2;
    const page = (docs: Record<string, unknown>[], queryid: number): string =>
      JSON.stringify({ ...first, data: JSON.stringify({ ...inner, queryid, count: total, docs }) });
    const second = inner.docs.map((doc) => ({ ...doc, id: (doc["id"] as number) + 100000, number: `9${String(doc["number"])}` }));
    const starts: number[] = [];
    const transport: Transport = async (request) => {
      if (!request.url.includes("Fulltext/Search")) {
        return { status: 200, headers: {}, body: Buffer.from("", "utf8") };
      }
      const body = JSON.parse(decodeURIComponent(String(request.body).replace(/^data=/, ""))) as { limit: { Start: number } };
      starts.push(body.limit.Start);
      const text = body.limit.Start === 0 ? page(inner.docs, 1) : page(second, 2);
      return { status: 200, headers: {}, body: Buffer.from(text, "utf8") };
    };
    const result = await new MecklenburgVorpommernParldokSource().discover({ engine: testEngine(transport), state: state });
    strictEqual(result.refs.length, total);
    deepStrictEqual(starts, [0, inner.docs.length]);
    strictEqual(new Set(result.refs.map((ref) => ref.key)).size, total);
  });

  it("stops paging at --limit", async () => {
    const { transport: scripted, requests } = transport();
    const result = await new MecklenburgVorpommernParldokSource().discover({ engine: testEngine(scripted), state: state, limit: 5 });
    strictEqual(result.refs.length, 5);
    strictEqual(requests.filter((request) => request.url.includes("Fulltext/Search")).length, 1);
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

  it("cleans a title and author field the way every scraped field is cleaned", () => {
    // A title with Word's line break (U+000B) used to fail the whole record
    // ("Invalid record: title: contains the control character U+000B"), and markup in
    // a field called `authorhtml` would have ended up in names and parties.
    const ref = toRef(
      {
        id: 1, lp: 8, number: "6809", date: "08.09.2026",
        title: "Klimaschutzprojekt &bdquo;Serrahn-S&uuml;d&ldquo;\u000bund\u0085mehr",
        authorhtml: "<a href=\"/x\">Martin Schmidt</a> (AfD), Landesregierung (Ministerium f&uuml;r Inneres und Bau)",
      },
      [],
    );
    strictEqual(ref?.title, "Klimaschutzprojekt „Serrahn-Süd“ und mehr");
    deepStrictEqual(ref?.askers, [{ name: "Martin Schmidt", party: "AfD" }]);
    deepStrictEqual(ref?.answered_by, { ministry: "Ministerium für Inneres und Bau" });
  });

  it("reports a page none of whose hits it can read as unreadable, so the aggregator is asked", async () => {
    // Every row with `number` as a JSON number (or `lp` as a string, or `id` renamed)
    // used to end as a successful, empty sync: each row skipped with one collapsed
    // warning, exit 0, no fallback — the opposite of the promise above.
    const envelope = JSON.parse(SEARCH) as { data: string };
    const inner = JSON.parse(envelope.data) as { docs: Record<string, unknown>[] };
    const changes: [string, (doc: Record<string, unknown>) => Record<string, unknown>][] = [
      ["number as a number", (doc) => ({ ...doc, number: Number(doc["number"]) })],
      ["lp as a string", (doc) => ({ ...doc, lp: String(doc["lp"]) })],
    ];
    for (const [label, change] of changes) {
      const body = JSON.stringify({ ...envelope, data: JSON.stringify({ ...inner, docs: inner.docs.map(change) }) });
      const { transport: scripted } = scriptedTransport([{ match: "Fulltext/Search", body }]);
      const result = await new MecklenburgVorpommernParldokSource().discover({ engine: testEngine(scripted), state });
      deepStrictEqual(result.refs, [], label);
      match(result.unreadable ?? "", /13 hit\(s\), none of which carries a number, id and Wahlperiode/, label);
    }
  });

  it("counts the hits it skipped in one warning when others are readable", async () => {
    const envelope = JSON.parse(SEARCH) as { data: string };
    const inner = JSON.parse(envelope.data) as { docs: Record<string, unknown>[] };
    const docs = inner.docs.map((doc, i) => (i < 2 ? { ...doc, number: 1 } : doc));
    const body = JSON.stringify({ ...envelope, data: JSON.stringify({ ...inner, docs }) });
    const { transport: scripted } = scriptedTransport([{ match: "Fulltext/Search", body }]);
    const result = await new MecklenburgVorpommernParldokSource().discover({ engine: testEngine(scripted), state });
    strictEqual(result.refs.length, 11);
    deepStrictEqual(result.warnings, ["Parldok returned 2 of 13 hit(s) without a number, id or Wahlperiode; skipped"]);
  });

  it("keeps only the Dokumenttyp and Wahlperiode it asked for", async () => {
    // The filter runs on the server of an undocumented API. A row of type 44 (the
    // unanswered "Kleine Anfrage"), a Protokoll or a row of another Wahlperiode used
    // to be stored as an answered Kleine Anfrage of the period asked for.
    const envelope = JSON.parse(SEARCH) as { data: string };
    const inner = JSON.parse(envelope.data) as { docs: Record<string, unknown>[] };
    const docs = inner.docs.map((doc, i) =>
      i === 0 ? { ...doc, typeid: 44, type: "Kleine Anfrage" } : i === 1 ? { ...doc, typeid: 3, kind: "Protokoll" } : i === 2 ? { ...doc, lp: 7 } : doc,
    );
    const body = JSON.stringify({ ...envelope, data: JSON.stringify({ ...inner, docs }) });
    const { transport: scripted } = scriptedTransport([{ match: "Fulltext/Search", body }]);
    const result = await new MecklenburgVorpommernParldokSource().discover({ engine: testEngine(scripted), state, period: 8 });
    strictEqual(result.refs.length, 10);
    ok(result.refs.every((ref) => ref.legislative_period === 8));
    deepStrictEqual(result.warnings, ["Parldok returned 3 of 13 hit(s) of another Dokumenttyp or Wahlperiode than asked for; skipped"]);

    // When nothing it asked for comes back, the filter itself has stopped working.
    const foreign = JSON.stringify({ ...envelope, data: JSON.stringify({ ...inner, docs: inner.docs.map((doc) => ({ ...doc, typeid: 44 })) }) });
    const { transport: all } = scriptedTransport([{ match: "Fulltext/Search", body: foreign }]);
    const none = await new MecklenburgVorpommernParldokSource().discover({ engine: testEngine(all), state });
    deepStrictEqual(none.refs, []);
    match(none.unreadable ?? "", /13 hit\(s\), none of them a "Kleine Anfrage und Antwort" of Wahlperiode 8/);
  });

  it("keeps one ref per Drucksachennummer and names the duplicate", async () => {
    // Two rows with one number and two documents were both fetched, reported as
    // "2/2 · 0 failed", and the second silently replaced the first record.
    const envelope = JSON.parse(SEARCH) as { data: string };
    const inner = JSON.parse(envelope.data) as { docs: Record<string, unknown>[] };
    const first = inner.docs[0] as Record<string, unknown>;
    const docs = [...inner.docs, { ...first, id: 99999, title: "Zweites Dokument, gleiche Nummer" }];
    const body = JSON.stringify({ ...envelope, data: JSON.stringify({ ...inner, count: docs.length, docs }) });
    const { transport: scripted } = scriptedTransport([{ match: "Fulltext/Search", body }]);
    const result = await new MecklenburgVorpommernParldokSource().discover({ engine: testEngine(scripted), state });
    strictEqual(result.refs.length, 13);
    const kept = result.refs.filter((ref) => ref.reference === `8/${String(first["number"])}`);
    strictEqual(kept.length, 1);
    strictEqual(kept[0]?.title, first["title"]);
    deepStrictEqual(result.warnings, [
      `Parldok listed Drucksache 8/${String(first["number"])} twice (documents ${String(first["id"])} and 99999); kept the first`,
    ]);
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
