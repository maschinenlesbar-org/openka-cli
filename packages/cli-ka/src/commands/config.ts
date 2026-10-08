// `ka config` — credentials kept apart from the corpus (issue #18). A key goes in
// through a prompt without echo or through stdin, never as an argument, so it reaches
// neither shell history nor `ps`; it lives in the user's credentials file
// (`CredentialStore`, lib-store), never in a corpus; and it comes out masked unless
// asked for in full.

import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import { OpenKaError, UsageError } from "@maschinenlesbar.org/openka-lib-errors";
import { createSource, sourceKeys } from "@maschinenlesbar.org/openka-lib-registry";
import { CredentialStore, credentialValueProblem, maskCredential } from "@maschinenlesbar.org/openka-lib-store";
import type { CliDeps } from "../io.js";
import { action, type ActionContext } from "../shared.js";
import { sanitizeForTerminal } from "../text.js";

/** The credentials there are: `<source>.api-key` for every source that takes a key. */
export function credentialNames(): string[] {
  return sourceKeys()
    .filter((key) => createSource(key).apiKeyEnv !== undefined)
    .map((key) => `${key}.api-key`);
}

/** commander value-parser: a credential this program knows. */
function parseCredentialName(value: string): string {
  const names = credentialNames();
  if (!names.includes(value)) throw new InvalidArgumentError(`Not a credential: expected one of ${names.join(", ")}.`);
  return value;
}

function storeOf(ctx: ActionContext): CredentialStore {
  return CredentialStore.fromEnv(ctx.deps.env);
}

export function registerConfig(program: Command, deps: CliDeps): void {
  const names = credentialNames().join(", ");
  const config = program
    .command("config")
    .description(`credentials kept apart from the corpus, in $XDG_CONFIG_HOME/openka/credentials (${names})`);

  config
    .command("set")
    .description("store a credential: typed at a prompt without echo, or piped in — never given as an argument")
    .argument("<name>", names, parseCredentialName)
    // Commander's own "too many arguments" error repeats them — here, the secret.
    .allowExcessArguments(true)
    .action(
      action(deps, async (ctx, positionals) => {
        if (ctx.args.length > 1) {
          throw new UsageError(
            "ka config set takes the name only: the value is read from a prompt or from stdin, never from the command line. " +
              "The one given is now in your shell history; if it is a secret, replace it there.",
          );
        }
        const name = positionals[0] as string;
        const store = storeOf(ctx);
        store.assertOutside(ctx.corpusRoot());
        if (ctx.deps.io.readSecret === undefined) throw new UsageError("No way to read a secret here: pipe it in, or run ka config set on a terminal.");
        const value = (await ctx.deps.io.readSecret(`${name}: `)).trim();
        const reason = credentialValueProblem(value);
        if (reason !== undefined) throw new UsageError(`${reason} Nothing was stored.`);
        store.set(name, value);
        ctx.deps.io.err(`Stored ${name} (${maskCredential(value)}) in ${sanitizeForTerminal(store.path)}.`);
      }),
    );

  config
    .command("get")
    .description("show a stored credential, masked (abcd…wxyz) unless --reveal")
    .argument("<name>", names, parseCredentialName)
    .option("--reveal", "print the whole value, for a script that passes it on — it then is on your screen or in its log")
    .action(
      action(deps, async (ctx, positionals) => {
        const name = positionals[0] as string;
        const store = storeOf(ctx);
        const value = store.get(name);
        if (value === undefined) throw new OpenKaError(`No ${name} is stored in ${store.path}; ka config set ${name} stores one.`);
        ctx.deps.io.out(ctx.opts["reveal"] === true ? value : maskCredential(value));
      }),
    );

  config
    .command("unset")
    .description("remove a stored credential")
    .argument("<name>", names, parseCredentialName)
    .action(
      action(deps, async (ctx, positionals) => {
        const name = positionals[0] as string;
        const store = storeOf(ctx);
        if (!store.unset(name)) throw new OpenKaError(`No ${name} is stored in ${store.path}.`);
        ctx.deps.io.err(`Removed ${name} from ${sanitizeForTerminal(store.path)}.`);
      }),
    );

  config
    .command("list")
    .description("every stored credential, masked, and where the file is")
    .action(
      action(deps, async (ctx) => {
        const store = storeOf(ctx);
        for (const name of store.names()) ctx.deps.io.out(`${name}  ${maskCredential(store.get(name) as string)}`);
        ctx.deps.io.err(`Credentials file: ${sanitizeForTerminal(store.path)}`);
      }),
    );
}
