// Assembles the `ka` command tree from injectable deps.

import { Command } from "commander";
import { PACKAGE_VERSION } from "@maschinenlesbar.org/openka-lib-repro";
import { defaultDeps, type CliDeps } from "./io.js";
import { addGlobalOptions } from "./shared.js";
import { registerSync } from "./commands/sync.js";
import { registerQuery } from "./commands/query.js";
import { registerMaintain } from "./commands/maintain.js";
import { registerOutput } from "./commands/output.js";

export { defaultDeps } from "./io.js";

export function buildProgram(deps: CliDeps = defaultDeps): Command {
  const program = new Command();
  program
    .name("ka")
    .description(
      "OpenKA — German parliamentary Kleine Anfragen in one standardized, reproducible format.\n" +
        "Deterministic by construction: no generative model runs in this program. When an\n" +
        "extractor cannot read a document it abstains and queues it for review.",
    )
    .version(PACKAGE_VERSION, "-v, --version")
    .showHelpAfterError();

  addGlobalOptions(program);
  registerSync(program, deps);
  registerQuery(program, deps);
  registerMaintain(program, deps);
  registerOutput(program, deps);

  program.addHelpText(
    "after",
    [
      "",
      "Examples:",
      "  ka sync --source berlin --since 2024-01-01 --limit 50",
      "  ka search \"Brücken Zustand\" --parliament berlin --year 2024",
      "  ka get berlin-19-10006 --format md",
      "  ka verify berlin-19-10006",
      "  ka review",
      "  ka export --format csv --out corpus.csv",
      "",
      "A record may publish with holes. `abstained_fields` names them, `ka review` lists them,",
      "and the archived PDF in the corpus is the appeal court for any field you doubt.",
    ].join("\n"),
  );
  return program;
}
