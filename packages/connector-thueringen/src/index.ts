// Thüringen: the Thüringer Landtag, whose Parlamentsdatenbank keeps the question
// and the answer in one Vorgang but publishes them as two unrelated Drucksachen.
//
// The answer's Drucksachennummer has no relation to the Kleine Anfrage's — 8/979 is
// answered by 8/1715 — and nothing in the question document names it; it is
// published weeks later.
//
// The Parlamentsspiegel does list it, as a follow-up document. This comment used to
// say it did not, which was an artefact of the aggregator parser splitting a result
// block on the `ps-folge` class: the portal emits that class only when the search
// filtered some of a Vorgang's follow-ups away, and every Thüringen row is
// unfiltered. Since that was fixed the row yields the answer's Parldok link, its
// date and the answering ministry, and the API below confirms the paper rather than
// being the only route to it.
//
// Parldok is a single-page application whose search runs over a JSON API. This
// adapter uses two of its endpoints, in the same way the application does:
//
//   Fulltext/Search   find the Kleine Anfrage by kind, number and Wahlperiode
//   Process/Document  list the Vorgang's positions, one of which is the answer
//
// That API is **undocumented**. It is the site's own public endpoint serving public
// documents, and asking it for JSON is gentler than scraping the rendered page, but
// nothing promises it will keep its shape. The adapter therefore treats every
// unexpected response as "no answer found" and says so, rather than failing the
// sync — and the Landtag publishing a documented interface would let all of this
// be deleted.

import { parseReference } from "@maschinenlesbar.org/openka-lib-models";
import { withDiscoveryState, type DiscoverOptions, type DiscoverResult, type DocRef, type DocRefDocument, type Source } from "@maschinenlesbar.org/openka-lib-source";
import { ParlamentsspiegelSource } from "@maschinenlesbar.org/openka-lib-parlamentsspiegel";
import type { SourceEntry } from "@maschinenlesbar.org/openka-lib-source";
import { answerPosition, firstHit, processBody, searchBody } from "@maschinenlesbar.org/openka-lib-parldok";
export * from "@maschinenlesbar.org/openka-lib-parldok";

/** The API host the Parldok application talks to. */
export const PARLDOK_API = "https://parldok.thltcloud.de/parldok";

/** The public host documents are served from. */
export const PARLDOK_WEB = "https://parldok.thueringer-landtag.de/ParlDok";

export class ThueringenSource implements Source {
  readonly key = "thueringen";
  readonly parliament = "thueringen" as const;
  readonly tier = "structured" as const;
  readonly label = "Thüringer Landtag (Parldok)";
  readonly homepage = "https://parldok.thueringer-landtag.de/ParlDok/";
  readonly notes =
    "Discovery runs through the Parlamentsspiegel, which lists the answer as a follow-up document " +
    "linking Parldok's viewer. The answer is a Drucksache with no relation to the Kleine Anfrage's number (8/979 is " +
    "answered by 8/1715), so it is looked up through Parldok's own JSON API — undocumented, so an " +
    "unexpected response means 'no answer found' rather than a failed sync. The answer document " +
    "holds the question and the reply together.";

  private readonly aggregator = new ParlamentsspiegelSource("thueringen");

  async discover(options: DiscoverOptions): Promise<DiscoverResult> {
    const discovered = await this.aggregator.discover(options);
    const warnings = [...discovered.warnings];
    const refs: DocRef[] = [];

    for (const ref of discovered.refs) {
      const answer = await this.findAnswer(ref, options, warnings);
      if (answer === undefined) {
        refs.push(ref);
        continue;
      }
      // The answer Drucksache reprints the question above the reply, so it is a
      // combined paper; the Kleine Anfrage itself stays as the question source. The
      // API's URL replaces the result row's link to the same paper — appending both
      // would fetch and extract it twice.
      const documents: DocRefDocument[] = [
        ...ref.documents.filter((document) => document.role === "question_pdf"),
        { role: "combined_pdf", url: answer.url, urlStable: true },
      ];
      refs.push({ ...ref, documents });
    }

    return withDiscoveryState(discovered, refs, warnings);
  }

  private async findAnswer(
    ref: DocRef,
    options: DiscoverOptions,
    warnings: string[],
  ): Promise<{ url: string; reference?: string } | undefined> {
    const number = parseReference(ref.reference)?.number ?? ref.reference;
    if (number === undefined || number === "") return undefined;
    try {
      const search = await options.engine.post(`${PARLDOK_API}/Fulltext/Search`, {
        body: `data=${encodeURIComponent(searchBody(String(Number(number)), ref.legislative_period))}`,
        headers: { accept: "application/json" },
      });
      const hit = firstHit(search.body.toString("utf8"));
      if (hit.kind === "unrecognised") {
        warnings.push(
          `${ref.reference}: Parldok's search answered in a form this adapter does not know ` +
            `(${hit.reason}) — treated as no answer, but the API may have changed`,
        );
        return undefined;
      }
      if (hit.kind === "absent") {
        warnings.push(`${ref.reference}: Parldok found no Kleine Anfrage with that number`);
        return undefined;
      }
      const process = await options.engine.post(`${PARLDOK_API}/Process/Document`, {
        body: `data=${encodeURIComponent(processBody(hit.value.id, hit.value.queryId))}`,
        headers: { accept: "application/json" },
      });
      const answer = answerPosition(process.body.toString("utf8"), PARLDOK_WEB);
      if (answer.kind === "unrecognised") {
        warnings.push(
          `${ref.reference}: Parldok's Vorgang answered in a form this adapter does not know ` +
            `(${answer.reason}) — treated as no answer, but the API may have changed`,
        );
        return undefined;
      }
      // Not an error: an Anfrage that has not been answered yet looks exactly like
      // this, and so does one whose answer Parldok has not published.
      if (answer.kind === "absent") return undefined;
      return answer.value;
    } catch (err) {
      warnings.push(`${ref.reference}: could not reach Parldok (${(err as Error).message})`);
      return undefined;
    }
  }
}

/** How this connector announces itself to the registry and `ka sources list`. */
export const ENTRY: SourceEntry = {
  key: "thueringen",
  parliament: "thueringen",
  label: "Thüringer Landtag (Parldok)",
  status: "implemented",
  note: "aggregator discovery, with the answer Drucksache looked up through Parldok's own JSON API",
  factory: () => new ThueringenSource(),
};
