/**
 * Live check of the CLI manager against the REAL machine and the REAL registries.
 *
 *   pnpm --filter @realm/server exec tsx scripts/live-cli-check.ts
 *
 * **This script installs nothing and updates nothing.** It only runs `--version`, resolves symlinks,
 * and issues public GETs — which is the point: the checking half of this feature is supposed to be
 * safe to run unattended, so a live check of it must be safe to run too. The one thing it does not
 * cover is `CliInstaller.start`, because covering that would mean running a package manager.
 *
 * What the unit fixtures cannot prove, and this does:
 *
 *   1. The registry shapes are still the shapes the parsers expect — a live `version` off npm and a
 *      live `versions.stable` off formulae.brew.sh, both parsed to a version this actually compares.
 *   2. Provenance on a real install tree: the classifier is fed real symlink chains from a real PATH,
 *      not paths a test wrote. Any kind reported as `unknown` is printed with its resolved path, so a
 *      layout Realm should recognise but does not shows up as a line to read rather than as silence.
 *   3. Every command Realm would run is printed in full, so the "show the exact command" promise is
 *      auditable by eye before any of it is ever wired to a button on a real machine.
 *
 * Exits non-zero if a check fails. Needs a network; agent CLIs are optional (an absent one is
 * reported as absent, which is a valid answer).
 */
import { AGENT_INSTALL_ROUTES, AgentKindSchema, isNewerVersion, parseBrewFormula, parseNpmLatest, parseVersion, updateChannel } from "@realm/contracts";
import { CliService } from "../src/cli/service";
import { agentBin } from "../src/cli/bins";
import { resolveInstall } from "../src/cli/provenance";
import { defaultAdapters } from "../src/app";
import { finish, ok } from "./harness";

async function main() {
  console.log("== registry shapes, live ==");
  // Two kinds with two different channels; both must parse to something `compareVersions` can order.
  const npmChannel = updateChannel(AGENT_INSTALL_ROUTES.codex)!;
  const brewChannel = updateChannel(AGENT_INSTALL_ROUTES["acp:goose"])!;
  for (const [label, channel] of [["npm", npmChannel], ["brew", brewChannel]] as const) {
    const res = await fetch(channel.url, { signal: AbortSignal.timeout(15_000), headers: { accept: "application/json" } });
    const body: unknown = await res.json();
    const version = channel.kind === "npm" ? parseNpmLatest(body) : parseBrewFormula(body);
    ok(`${label} ${channel.url} answers 200`, res.ok, `status ${res.status}`);
    ok(`${label} parses to a version`, !!version && !!parseVersion(version), String(version));
  }

  console.log("\n== this machine, as the classifier sees it ==");
  let anyInstalled = false;
  for (const kind of AgentKindSchema.options) {
    const bin = agentBin(kind);
    if (!bin) continue;
    const found = await resolveInstall(bin);
    if (!found) { console.log(`  --    ${kind.padEnd(14)} not on PATH`); continue; }
    anyInstalled = true;
    console.log(`  --    ${kind.padEnd(14)} ${found.provenance.padEnd(8)} ${found.realPath}`);
  }
  ok("at least one agent CLI is installed, so provenance was exercised at all", anyInstalled);

  console.log("\n== cli.status, end to end ==");
  const adapters = defaultAdapters();
  const probe = async () => (await Promise.all(Object.values(adapters).map((a) => a!.probe()))).flat();
  const rows = await new CliService({ probe }).status();

  for (const r of rows) {
    const bits = [
      r.installed ? `installed ${r.version ?? "?"}` : "not installed",
      `via ${r.provenance}`,
      r.latest ? `latest ${r.latest}` : "latest unknown",
      `action ${r.action}`,
    ];
    console.log(`  --    ${r.kind.padEnd(14)} ${bits.join(" · ")}`);
    if (r.binPath) console.log(`        at:        ${r.binPath}`);
    if (r.command) console.log(`        would run: ${r.command}`);
    if (r.refusal) console.log(`        refused:   ${r.refusal}`);
  }

  console.log("\n== the invariants that keep this safe ==");
  // Only invariants that a real machine can actually break belong here. The provenance rule ("no
  // `npm install -g` over a Homebrew install") and "an install is only offered for an absent CLI"
  // are NOT among them: `join` derives `action` from `canRunUpdate` and `installCommand`, so
  // re-deriving them from the same pure functions in the same process cannot fail. `service.test.ts`
  // is where those live, against fixtures that can disagree.
  //
  // `updateAvailable` is worth re-deriving because `join` adds a `!latest` clause of its own on top
  // of the comparison, and a real registry answer is what makes the two able to diverge.
  const bogus = rows.filter((r) => r.updateAvailable !== isNewerVersion(r.version, r.latest));
  ok("updateAvailable agrees with the version comparison", bogus.length === 0, bogus.map((r) => r.kind).join(", "));
  ok("fake is never offered anything", rows.find((r) => r.kind === "fake")?.action === "none");

  finish();
}

void main();
