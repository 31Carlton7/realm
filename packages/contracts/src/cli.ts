import type { AgentKind } from "./entities";

/**
 * How each agent's CLI actually gets onto a machine, structured.
 *
 * `AGENT_CLI_COMMANDS` (presets.ts) already carries the install command as prose for copying. This
 * table carries the same fact in the shape the update checker needs — a method plus the one
 * identifier that method looks a version up by — and `installCommand()` below regenerates that prose
 * from it. `cli.test.ts` asserts the two agree for every kind, so the copyable string and the string
 * Realm would run can never drift apart.
 *
 * `null` means Realm has no install route for the kind and must offer no button: `fake` is compiled
 * in, and any future kind whose install method cannot be established belongs here rather than
 * getting a guessed package name.
 */
export type InstallRoute =
  /** A global npm package. `pkg` is the registry name, which is also its `latest` lookup key. */
  | { method: "npm"; pkg: string }
  /** A Homebrew formula. `formula` is the name, which is also its formulae.brew.sh lookup key. */
  | { method: "brew"; formula: string }
  /**
   * A vendor install script piped into a shell. `command` is verbatim from the vendor's own docs
   * (flag order included — it is not normalized, because the string a user copies should be the
   * string the vendor published). `host` is the domain the script is fetched from, so the UI can
   * name who is about to run code on the machine.
   */
  | { method: "script"; host: string; command: string };

/**
 * Every kind's route. Each entry's identifier comes from the same source as its
 * `AGENT_CLI_COMMANDS[kind].install` prose — the provider's own install docs — and nothing here is
 * inferred from a binary name.
 */
export const AGENT_INSTALL_ROUTES = {
  claude: { method: "npm", pkg: "@anthropic-ai/claude-code" },
  codex: { method: "npm", pkg: "@openai/codex" },
  "acp:gemini": { method: "npm", pkg: "@google/gemini-cli" },
  "acp:cursor": { method: "script", host: "cursor.com", command: "curl https://cursor.com/install -fsS | bash" },
  "acp:opencode": { method: "npm", pkg: "opencode-ai" },
  "acp:copilot": { method: "npm", pkg: "@github/copilot" },
  "acp:goose": { method: "brew", formula: "block-goose-cli" },
  "acp:qwen": { method: "npm", pkg: "@qwen-code/qwen-code" },
  "acp:grok": { method: "npm", pkg: "@xai-official/grok" },
  "acp:fx": { method: "script", host: "fx.sh", command: "curl -fsSL https://fx.sh/setup.sh | bash" },
  // The ACP server package, not the `dsh` launcher — see AGENT_CLI_COMMANDS for why this install
  // fails today against the published registry.
  "acp:deepseek": { method: "npm", pkg: "@deepseek-ai/dsh-acp-demo" },
  fake: null,
} as const satisfies Record<AgentKind, InstallRoute | null>;

/** The command that puts the CLI on the machine, or null when there is no route. */
export function installCommand(route: InstallRoute | null): string | null {
  if (!route) return null;
  if (route.method === "npm") return `npm install -g ${route.pkg}`;
  if (route.method === "brew") return `brew install ${route.formula}`;
  return route.command;
}

/**
 * The command that moves an installed CLI to `version`, or null when Realm must not offer one.
 *
 * npm installs are pinned to the exact version the check found rather than `@latest`, so the command
 * the user reads before clicking is the command whose outcome the UI just promised — with `@latest`
 * a publish landing between the check and the click would install a version nobody agreed to.
 *
 * Script routes get null: re-running a vendor's install script does update the CLI, but there is no
 * channel to learn what version it would land on (see `updateChannel`), so Realm would be offering
 * an update it cannot claim is one.
 */
export function updateCommand(route: InstallRoute | null, version: string): string | null {
  if (!route || !version) return null;
  if (route.method === "npm") return `npm install -g ${route.pkg}@${version}`;
  if (route.method === "brew") return `brew upgrade ${route.formula}`;
  return null;
}

/**
 * Where a route's "what is the newest version" answer comes from, or null when it has none.
 *
 * Both endpoints are public, unauthenticated, single-GET JSON, and neither carries anything about the
 * user — same standing as MODEL_CATALOG_URL.
 */
export function updateChannel(route: InstallRoute | null): { url: string; kind: "npm" | "brew" } | null {
  if (!route) return null;
  // The registry wants a scoped name with only its slash escaped (`@openai%2Fcodex`);
  // encodeURIComponent would also escape the leading `@`, which the registry 404s on.
  if (route.method === "npm") return { url: `https://registry.npmjs.org/${route.pkg.replace("/", "%2F")}/latest`, kind: "npm" };
  if (route.method === "brew") return { url: `https://formulae.brew.sh/api/formula/${route.formula}.json`, kind: "brew" };
  return null;
}

/** `{ version }` off a registry `latest` document. Anything else reads as "no answer" rather than
 *  throwing — an update check may never be able to fail its caller. */
export function parseNpmLatest(body: unknown): string | null {
  const v = (body as { version?: unknown } | null)?.version;
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/** `versions.stable` off a formulae.brew.sh formula document. Shape verified against the public API
 *  2026-09-05; `versions.head` is deliberately ignored, since `brew install` lands stable. */
export function parseBrewFormula(body: unknown): string | null {
  const v = (body as { versions?: { stable?: unknown } } | null)?.versions?.stable;
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/**
 * The version number inside whatever a `--version` flag printed.
 *
 * Every CLI decorates it differently — measured: claude prints `2.1.223 (Claude Code)`, codex prints
 * `codex-cli 0.146.0`, cursor-agent prints a calendar version like `2026.09.01`. At least one dot is
 * required so a lone digit in a product name (`gpt-5-codex`) is not mistaken for a version; the first
 * match wins, because every observed format puts the version after any name and before any build
 * decoration.
 */
export function parseVersion(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return /\d+(?:\.\d+)+(?:-[0-9A-Za-z.]+)?/.exec(raw)?.[0] ?? null;
}

const segments = (v: string): number[] => v.split(".").map((s) => Number.parseInt(s, 10) || 0);

/**
 * Orders two release versions: negative when `a` is older, positive when newer, 0 when equal.
 *
 * Numeric segment compare with missing segments read as 0, so `1.2` and `1.2.0` are the same release.
 * A prerelease suffix orders BELOW the same numbers without one (`1.2.0-rc.1` < `1.2.0`), which is
 * semver's rule and the one that matters here: it stops an installed release candidate from reading
 * as newer than the stable build that superseded it. Two prereleases of the same version compare
 * lexically — good enough, because Realm only ever asks "is the registry strictly ahead of me".
 */
export function compareVersions(a: string, b: string): number {
  const [aCore = "", aPre = ""] = a.split("-", 2);
  const [bCore = "", bPre = ""] = b.split("-", 2);
  const as = segments(aCore);
  const bs = segments(bCore);
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const d = (as[i] ?? 0) - (bs[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (aPre === bPre) return 0;
  if (aPre === "") return 1;
  if (bPre === "") return -1;
  return aPre < bPre ? -1 : 1;
}

/** True only when `latest` is a real version strictly ahead of a real `installed`. An unparseable
 *  version on either side answers false: "we cannot tell" must never render as "update available". */
export function isNewerVersion(installed: string | null | undefined, latest: string | null | undefined): boolean {
  const a = parseVersion(installed);
  const b = parseVersion(latest);
  if (!a || !b) return false;
  return compareVersions(a, b) < 0;
}

/**
 * How the installed binary got onto the machine, as far as its resolved path can prove.
 *
 * `unknown` is the honest majority answer — a downloaded binary, a vendor install script, or a
 * package manager Realm does not classify all land there — and it is not a failure state. It only
 * means Realm will not run an update command for that binary.
 */
export type InstallProvenance = "npm" | "pnpm" | "brew" | "unknown";

/**
 * Whether Realm may offer to run `route`'s update command against a binary of this provenance.
 *
 * The rule is "do not update what you did not install, by a method that did not install it". Running
 * `npm install -g` against a Homebrew-installed CLI does not upgrade it — it drops a second copy into
 * the npm prefix and whichever comes first on PATH wins, which is a confusing machine and a support
 * problem Realm would have created. npm and pnpm are interchangeable here only in that both put the
 * package under a global `node_modules`; an `npm install -g` over a pnpm global install is still a
 * second copy, so pnpm is refused too.
 */
export function canRunUpdate(route: InstallRoute | null, provenance: InstallProvenance): boolean {
  if (!route) return false;
  if (route.method === "npm") return provenance === "npm";
  if (route.method === "brew") return provenance === "brew";
  return false;
}

/** Why an update Realm found cannot be applied for the user, in the user's terms. Null when it can. */
export function updateRefusal(route: InstallRoute | null, provenance: InstallProvenance): string | null {
  if (!route || canRunUpdate(route, provenance)) return null;
  if (route.method === "script") return "Realm can't update this one — its installer is a script from the vendor, and re-running it gives no way to confirm which version you'd land on.";
  const want = route.method === "npm" ? "npm" : "Homebrew";
  const have = provenance === "brew" ? "Homebrew" : provenance === "unknown" ? "something other than a package manager Realm recognises" : provenance;
  return `Installed with ${have}, so Realm won't update it with ${want} — that would leave a second copy on your PATH instead of upgrading this one.`;
}

/**
 * One agent CLI's whole situation on this machine, as the Settings engines list and the install card
 * read it.
 *
 * `action` is the only field a button should branch on, and it is deliberately narrower than the rest
 * of the row: `updateAvailable` can be true while `action` is `"none"`, which is the case where Realm
 * found a newer version but must not apply it (see `refusal`). Telling the user an update exists and
 * refusing to run it is more useful than hiding either half.
 */
export type CliStatus = {
  kind: AgentKind;
  installed: boolean;
  /** Raw, exactly as the CLI printed it — `parseVersion` is for comparing, not for showing. */
  version: string | null;
  /** The PATH entry the binary was found at, null when it is not installed or was not resolved. */
  binPath: string | null;
  provenance: InstallProvenance;
  /** Newest published version, null when the CLI is absent, has no channel, or the lookup failed. */
  latest: string | null;
  /** Whether this route has any way to learn a published version at all. */
  channel: boolean;
  updateAvailable: boolean;
  action: "install" | "update" | "none";
  /** The exact command `action` would run, shown before it runs. Null when `action` is `"none"`. */
  command: string | null;
  /** Why an available update is not offered as a button. Null whenever there is nothing to explain. */
  refusal: string | null;
};
