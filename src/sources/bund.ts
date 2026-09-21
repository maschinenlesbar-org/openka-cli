// The Bundestag: DIP, the Dokumentations- und Informationssystem für
// Parlamentsmaterialien (https://search.dip.bundestag.de/api/v1).
//
// This is the cleanest source in the project — a real JSON API with filters and
// cursor pagination — so the adapter is what the concept calls a trivial
// deterministic mapper. It needs an API key (`--api-key`, `DIP_API_KEY`); the
// Bundestag publishes a public one on https://dip.bundestag.de/über-dip/hilfe/api
// and issues personal keys on request. No key is bundled here.
//
// A Kleine Anfrage is a *Vorgang* with two *Vorgangspositionen*: the question
// ("Kleine Anfrage") and the government's reply ("Antwort"). Discovery filters
// positions by date, then groups them by `vorgang_id`. Because a question and its
// answer are typically four weeks apart, a date window routinely contains one half
// of a pair — those are completed with a targeted per-Vorgang request rather than
// being published as a record with an invented counterpart.

import { ParseError } from "../core/errors.js";
import type { AnsweredBy, Asker } from "../core/models/schema.js";
import { periodFromReference } from "../core/extract/metadata.js";
import type { DiscoverOptions, DiscoverResult, DocRef, DocRefDocument, Source } from "./base.js";
import { applyWindow } from "./base.js";

export const DIP_BASE_URL = "https://search.dip.bundestag.de";
export const DIP_API_KEY_ENV = "DIP_API_KEY";

/** Cap on the follow-up requests used to complete half-seen pairs in one run. */
const MAX_REPAIR_REQUESTS = 50;

/** Cursor pages to walk before giving up, a guard against a cursor that never settles. */
const MAX_PAGES = 200;

interface DipListResult {
  numFound?: number;
  documents?: Record<string, unknown>[];
  cursor?: string;
}

export class BundDipSource implements Source {
  readonly key = "bund";
  readonly parliament = "bund" as const;
  readonly tier = "structured" as const;
  readonly label = "Deutscher Bundestag (DIP)";
  readonly homepage = "https://dip.bundestag.de/";
  readonly notes =
    "Question and answer are two Drucksachen of one Vorgang; a date window usually " +
    "splits a pair, so half-seen pairs are completed with a per-Vorgang request. " +
    "Needs an API key (--api-key / DIP_API_KEY).";
  readonly apiKeyEnv = DIP_API_KEY_ENV;

  async discover(options: DiscoverOptions): Promise<DiscoverResult> {
    if (options.apiKey === undefined || options.apiKey.trim() === "") {
      throw new ParseError(
        `The Bundestag DIP API needs a key. Pass --api-key, or set ${DIP_API_KEY_ENV}. ` +
          "The Bundestag publishes a public key on https://dip.bundestag.de/über-dip/hilfe/api.",
      );
    }
    const warnings: string[] = [];
    const params: Record<string, string | number> = {
      "f.vorgangstyp": "Kleine Anfrage",
      format: "json",
    };
    if (options.since !== undefined) params["f.datum.start"] = options.since;
    if (options.until !== undefined) params["f.datum.end"] = options.until;
    if (options.period !== undefined) params["f.wahlperiode"] = options.period;

    const positions = await this.page(options, "/api/v1/vorgangsposition", params, options.limit);
    const groups = new Map<string, Record<string, unknown>[]>();
    for (const position of positions) {
      const vorgang = String(position["vorgang_id"] ?? "");
      if (vorgang === "") continue;
      const bucket = groups.get(vorgang) ?? [];
      bucket.push(position);
      groups.set(vorgang, bucket);
    }

    let repairs = 0;
    for (const [vorgang, bucket] of [...groups].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (bucket.some((p) => p["vorgangsposition"] === "Kleine Anfrage") &&
          bucket.some((p) => p["vorgangsposition"] === "Antwort")) {
        continue;
      }
      if (repairs >= MAX_REPAIR_REQUESTS) {
        warnings.push(
          `stopped completing half-seen pairs after ${MAX_REPAIR_REQUESTS} requests; ` +
            "narrow the window or re-run to pick up the rest",
        );
        break;
      }
      repairs++;
      const complete = await this.page(options, "/api/v1/vorgangsposition", {
        "f.vorgang": vorgang,
        format: "json",
      });
      if (complete.length > 0) groups.set(vorgang, complete);
    }

    const refs: DocRef[] = [];
    for (const [vorgang, bucket] of groups) {
      const ref = toRef(vorgang, bucket, warnings);
      if (ref !== undefined) refs.push(ref);
    }
    // The window is re-applied to the assembled refs: a repair request deliberately
    // ignores the date filter, so without this a completed pair from outside the
    // window would slip in.
    return { refs: applyWindow(refs, options), warnings };
  }

  /** Walk the cursor until it stops moving, which is how DIP signals the end. */
  private async page(
    options: DiscoverOptions,
    path: string,
    params: Record<string, string | number>,
    limit?: number,
  ): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const query: Record<string, string | number> = { ...params };
      if (cursor !== undefined) query["cursor"] = cursor;
      const response = await options.engine.get(`${DIP_BASE_URL}${path}`, {
        params: query,
        headers: { authorization: `ApiKey ${options.apiKey}`, accept: "application/json" },
      });
      let body: DipListResult;
      try {
        body = JSON.parse(response.body.toString("utf8")) as DipListResult;
      } catch (err) {
        throw new ParseError(`DIP returned a body that is not JSON (${path})`, { cause: err });
      }
      const documents = body.documents ?? [];
      out.push(...documents);
      // Two positions per Anfrage, so the position budget is twice the ref budget.
      if (limit !== undefined && out.length >= limit * 2) break;
      if (documents.length === 0 || body.cursor === undefined || body.cursor === cursor) break;
      cursor = body.cursor;
    }
    return out;
  }
}

/** Build a DocRef from the positions of one Vorgang. */
export function toRef(
  vorgangId: string,
  positions: Record<string, unknown>[],
  warnings: string[],
): DocRef | undefined {
  const question = positions.find((p) => p["vorgangsposition"] === "Kleine Anfrage");
  const answer = positions.find((p) => p["vorgangsposition"] === "Antwort");
  if (question === undefined) {
    warnings.push(`Vorgang ${vorgangId}: no "Kleine Anfrage" position found; skipped`);
    return undefined;
  }
  const questionFundstelle = record(question["fundstelle"]);
  const reference = stringOf(questionFundstelle?.["dokumentnummer"]);
  if (reference === undefined) {
    warnings.push(`Vorgang ${vorgangId}: the question has no Drucksachennummer; skipped`);
    return undefined;
  }
  const period = periodFromReference(reference);
  if (period === undefined) {
    warnings.push(`Vorgang ${vorgangId}: cannot read a Wahlperiode from "${reference}"; skipped`);
    return undefined;
  }

  const documents: DocRefDocument[] = [];
  const questionPdf = stringOf(questionFundstelle?.["pdf_url"]);
  if (questionPdf !== undefined) documents.push({ role: "question_pdf", url: questionPdf, urlStable: true });
  const answerFundstelle = answer !== undefined ? record(answer["fundstelle"]) : undefined;
  const answerPdf = stringOf(answerFundstelle?.["pdf_url"]);
  if (answerPdf !== undefined) documents.push({ role: "answer_pdf", url: answerPdf, urlStable: true });

  const answeredBy: AnsweredBy = {};
  const ressorts = Array.isArray(answer?.["ressort"]) ? (answer["ressort"] as unknown[]) : [];
  const lead = ressorts.map(record).find((entry) => entry?.["federfuehrend"] === true) ?? ressorts.map(record)[0];
  const ministry = stringOf(lead?.["titel"]);
  if (ministry !== undefined) answeredBy.ministry = ministry;

  const ref: DocRef = {
    key: vorgangId,
    reference,
    legislative_period: period,
    title: stringOf(question["titel"]) ?? "",
    documentType: "kleine_anfrage",
    askers: askersOf(question),
    answered_by: answeredBy,
    dates: {},
    documents,
  };
  const submitted = isoDate(stringOf(questionFundstelle?.["datum"]) ?? stringOf(question["datum"]));
  if (submitted !== undefined) ref.dates.submitted = submitted;
  const answered = isoDate(stringOf(answerFundstelle?.["datum"]) ?? stringOf(answer?.["datum"]));
  if (answered !== undefined) ref.dates.answered = answered;
  return ref;
}

/**
 * Who asked. DIP names the individual MdBs in `aktivitaet_anzeige`; when only a
 * Fraktion brought the Anfrage in, `urheber` carries it, and the Fraktion is
 * recorded as the asker with `role: "Fraktion"` rather than being turned into a
 * person who does not exist.
 */
export function askersOf(position: Record<string, unknown>): Asker[] {
  const askers: Asker[] = [];
  const seen = new Set<string>();
  const activities = Array.isArray(position["aktivitaet_anzeige"]) ? (position["aktivitaet_anzeige"] as unknown[]) : [];
  for (const activity of activities) {
    const titel = stringOf(record(activity)?.["titel"]);
    if (titel === undefined) continue;
    const asker = parseDipAuthor(titel);
    if (asker === undefined || seen.has(asker.name)) continue;
    seen.add(asker.name);
    askers.push(asker);
  }
  if (askers.length > 0) return askers;

  const urheber = Array.isArray(position["urheber"]) ? (position["urheber"] as unknown[]) : [];
  for (const entry of urheber) {
    const parsed = record(entry);
    const titel = stringOf(parsed?.["titel"]);
    if (titel === undefined || seen.has(titel)) continue;
    seen.add(titel);
    const asker: Asker = { name: titel, role: "Fraktion" };
    const bezeichnung = stringOf(parsed?.["bezeichnung"]);
    if (bezeichnung !== undefined) asker.party = bezeichnung;
    askers.push(asker);
  }
  return askers;
}

/** `Dr. Alaa Alhamwi, MdB, BÜNDNIS 90/DIE GRÜNEN` -> name / role / party. */
export function parseDipAuthor(display: string): Asker | undefined {
  const parts = display.split(",").map((part) => part.trim()).filter((part) => part !== "");
  if (parts.length === 0) return undefined;
  const name = parts[0] as string;
  if (name === "") return undefined;
  const asker: Asker = { name };
  for (const part of parts.slice(1)) {
    if (/^(MdB|MdL|MdA|Abg\.?)$/i.test(part)) asker.role = part;
    else if (asker.party === undefined) asker.party = part;
  }
  return asker;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** DIP dates are already ISO `YYYY-MM-DD`; anything else is rejected, not coerced. */
function isoDate(value: string | undefined): string | undefined {
  return value !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
}
