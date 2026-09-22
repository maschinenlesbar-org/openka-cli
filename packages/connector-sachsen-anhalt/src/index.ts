// Landtag von Sachsen-Anhalt: published openly, and disallowed to every client in robots.txt.
//
// Sachsen-Anhalt's PADOKA is a STARWEB installation, so `lib-starweb` would very likely
// reach it. Its robots.txt is the obstacle — and it is **malformed**: two separate
// `User-agent: *` groups, the first disallowing only `/files/`, the last disallowing
// everything. RFC 9309 applies every matching group, so the conservative and correct
// reading is a whole-site block, and that is the reading taken here.
//
// It is more likely an editing accident than a policy, which makes it worth asking
// the Landtag about rather than reinterpreting unilaterally.
//
// **What this connector does.** Discovery runs through the Parlamentsspiegel, which
// Sachsen-Anhalt delivers to itself and which is not restricted — that yields the
// Drucksachennummer, the title, the asker and the dates. The *documents* live on
// `padoka.landtag.sachsen-anhalt.de`, whose robots.txt reads:
//
//     User-agent: *
//     Disallow: /
//
// So by default this source produces nothing, and says why. With `--ignore-robots`
// it produces the full records. The file is read at run time, not baked in, so if
// the Landtag lifts the rule this connector starts working without a release.
//
// **Why the default is to produce nothing rather than metadata-only records.** A
// record with no text abstains on everything it exists to carry — no full text, no
// question, no answer. A corpus full of those is worse than an honest gap, and the
// gap is visible in `ka sources show sachsen-anhalt`.
//
// **And if you do override it, this source goes slowly.** `minHostIntervalMs` is
// set well above the default: a server that asked not to be crawled should not then
// be hit at the usual rate.

import {
  robotsGate,
  type DiscoverOptions,
  type DiscoverResult,
  type Source,
  type SourceEntry,
} from "@maschinenlesbar.org/openka-lib-source";
import { ParlamentsspiegelSource } from "@maschinenlesbar.org/openka-lib-parlamentsspiegel";

export const PARLIAMENT = "sachsen-anhalt" as const;
export const LABEL = "Landtag von Sachsen-Anhalt";

/** The server the Drucksachen live on, and which disallows every client. */
export const DOCUMENT_ORIGIN = "https://padoka.landtag.sachsen-anhalt.de";

/** A path under the document server, for the robots.txt question. */
export const DOCUMENT_PATH = "/starweb/PADOKA/servlet.starweb";

/**
 * One request every four seconds. The default is 500 ms; a server that has asked
 * not to be crawled at all gets the slowest rate this tool offers.
 */
export const POLITE_INTERVAL_MS = 4000;

export class SachsenAnhaltSource implements Source {
  readonly key = PARLIAMENT;
  readonly parliament = PARLIAMENT;
  readonly tier = "text_layer" as const;
  readonly label = LABEL;
  readonly homepage = "https://padoka.landtag.sachsen-anhalt.de/";
  readonly minHostIntervalMs = POLITE_INTERVAL_MS;
  readonly notes =
    "Discovery through the Parlamentsspiegel, which is unrestricted. The documents live on a " +
    "server whose robots.txt disallows every client, so this source yields nothing unless the " +
    "operator passes --ignore-robots. The file is checked at run time, so the default corrects " +
    "itself if the Landtag changes its mind.";

  private readonly aggregator = new ParlamentsspiegelSource(PARLIAMENT);

  async discover(options: DiscoverOptions): Promise<DiscoverResult> {
    const gate = await robotsGate(options.engine, {
      origin: DOCUMENT_ORIGIN,
      path: DOCUMENT_PATH,
      ...(options.ignoreRobots === undefined ? {} : { ignoreRobots: options.ignoreRobots }),
    });
    if (!gate.allowed) {
      return { refs: [], warnings: [gate.note as string] };
    }
    const discovered = await this.aggregator.discover(options);
    const warnings = [...discovered.warnings];
    if (gate.overridden) warnings.unshift(gate.note as string);
    return { ...discovered, warnings };
  }
}

/**
 * What `createSource()` returns: the gated source itself, with no fallback wrapper.
 *
 * The other connectors wrap the Land's own interface with the aggregator behind it.
 * Here the Land's own interface *is* the aggregator — discovery already runs through
 * the Parlamentsspiegel, behind the robots.txt gate — so a fallback would retry the
 * same host with the same request, and its composed `notes` would tell
 * `ka sources show` that this source falls back to itself.
 */
export function createSource(): Source {
  return new SachsenAnhaltSource();
}

/** How this connector announces itself to the registry and `ka sources list`. */
export const ENTRY: SourceEntry = {
  key: PARLIAMENT,
  parliament: PARLIAMENT,
  label: LABEL,
  status: "implemented",
  note: "aggregator discovery; the documents are robots-disallowed and need --ignore-robots",
  factory: createSource,
};
