import { tempDir } from "@realm/test-utils";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProbeResult } from "@realm/adapters";
import type { AgentKind } from "@realm/contracts";
import { CliService } from "./service";
import { updateSpecFor } from "./install";

/** A PATH directory holding the named binaries, each a symlink into the layout its package manager
 *  would have produced. No package manager is ever run — the layout IS the fact under test. */
function machine(installs: { bin: string; under: "npm" | "brew" | "unknown" }[]): { PATH: string } {
  const root = tempDir("realm-clisvc-");
  const binDir = join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  for (const { bin, under } of installs) {
    // `unknown` is a real binary in a real directory that resolves to no package manager — a hand
    // build, a vendor installer, a copy into ~/.local/bin. It is not a missing file.
    const real = under === "brew"
      ? join(root, "Cellar", bin, "1.0.0", "bin", bin)
      : under === "unknown"
      ? join(root, "opt", bin)
      : join(root, "lib", "node_modules", bin, "bin", `${bin}.js`);
    mkdirSync(dirname(real), { recursive: true });
    writeFileSync(real, "#!/bin/sh\n", { mode: 0o755 });
    symlinkSync(real, join(binDir, bin));
  }
  return { PATH: binDir };
}

type Registry = Record<string, unknown>;

/** A fetch that answers only from `registry`, and counts every request so caching can be proven. */
function fakeFetch(registry: Registry) {
  const urls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    const body = registry[url];
    if (body === undefined) return { ok: false, status: 404, json: async () => ({}) } as Response;
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as unknown as typeof fetch;
  return { impl, urls };
}

const CODEX_LATEST = "https://registry.npmjs.org/@openai%2Fcodex/latest";
const GOOSE_LATEST = "https://formulae.brew.sh/api/formula/block-goose-cli.json";
/* Gemini stands in for "a CLI with no updater of its own" throughout the provenance cases below.
   Codex used to, and cannot any more: `codex update` exists, and a kind whose CLI updates itself
   never reaches the provenance rule at all. The rule is still real — it is what gemini, qwen, goose,
   copilot, grok and deepseek get — so the tests moved to a kind it actually governs. */
const GEMINI_LATEST = "https://registry.npmjs.org/@google%2Fgemini-cli/latest";

function probes(rows: Partial<ProbeResult>[]): (o: { force?: boolean }) => Promise<ProbeResult[]> {
  return async () => rows.map((r) => ({ kind: "fake" as AgentKind, available: true, version: null, loggedIn: null, reason: null, ...r }));
}

const row = (rows: Awaited<ReturnType<CliService["status"]>>, kind: AgentKind) => rows.find((r) => r.kind === kind)!;

describe("CliService.status", () => {
  it("offers an update when the registry is ahead of an npm install", async () => {
    const env = machine([{ bin: "gemini", under: "npm" }]);
    const { impl } = fakeFetch({ [GEMINI_LATEST]: { version: "0.9.1" } });
    const svc = new CliService({ probe: probes([{ kind: "acp:gemini", version: "0.8.0" }]), fetchImpl: impl, env });
    const gemini = row(await svc.status(), "acp:gemini");
    expect(gemini.updateAvailable).toBe(true);
    expect(gemini.action).toBe("update");
    expect(gemini.command).toBe("npm install -g @google/gemini-cli@0.9.1");
    expect(gemini.provenance).toBe("npm");
    expect(gemini.refusal).toBe(null);
  });

  it("offers nothing when the installed version is already the published one", async () => {
    const env = machine([{ bin: "gemini", under: "npm" }]);
    const { impl } = fakeFetch({ [GEMINI_LATEST]: { version: "0.8.0" } });
    const svc = new CliService({ probe: probes([{ kind: "acp:gemini", version: "0.8.0" }]), fetchImpl: impl, env });
    const gemini = row(await svc.status(), "acp:gemini");
    expect(gemini.updateAvailable).toBe(false);
    expect(gemini.action).toBe("none");
    expect(gemini.command).toBe(null);
    expect(gemini.latest).toBe("0.8.0");
  });

  it("still refuses when it cannot attribute the install of a CLI that has no updater of its own", async () => {
    /* `unknown` is not laziness. A binary Realm cannot trace to a package manager is one where every
       upgrade command Realm could run is a guess, and guessing wrong installs a second copy — the
       exact harm the whole refusal exists to prevent. What changed is that the refusal is now the
       LAST answer rather than the first: a CLI that updates itself is asked to. */
    const env = machine([{ bin: "gemini", under: "unknown" }]);
    const { impl } = fakeFetch({ [GEMINI_LATEST]: { version: "0.9.1" } });
    const svc = new CliService({ probe: probes([{ kind: "acp:gemini", version: "0.8.0" }]), fetchImpl: impl, env });
    const gemini = row(await svc.status(), "acp:gemini");
    expect(gemini.updateAvailable).toBe(true);
    expect(gemini.action).toBe("none");
    expect(gemini.command).toBe(null);
    expect(gemini.refusal).toContain("something other than a package manager");
  });

  it("runs the CLI's OWN updater whatever the provenance, and names the version when it knows one", async () => {
    /* The case the user hit: claude installs to ~/.local/bin as a native binary, which Realm cannot
       attribute, so every version of this code before it said "there is a newer version and Realm
       will not fetch it" — about a CLI that ships `claude update`. `codex update` and
       `cursor-agent update` were in the same position. */
    const env = machine([{ bin: "codex", under: "unknown" }]);
    const { impl } = fakeFetch({ [CODEX_LATEST]: { version: "0.153.4" } });
    const svc = new CliService({ probe: probes([{ kind: "codex", version: "codex-cli 0.146.0" }]), fetchImpl: impl, env });
    const codex = row(await svc.status(), "codex");
    expect(codex.updateAvailable).toBe(true);
    expect(codex.action).toBe("update");
    expect(codex.command).toBe("codex update");
    expect(codex.refusal).toBe(null);
  });

  it("offers no command the run path cannot build — the two halves of `cli.run`, joined", async () => {
    /* The reported failure: "no update command for acp:fx". `status` resolves what to offer through
       `updatePlan`, and `cli.run` used to resolve what to SPAWN through the install route — so fx,
       installed by vendor script and updated by `fx upgrade`, got a button that answered with an
       error, and codex got one that ran the wrong command. Both halves now go through the same
       plan, and this is the assertion that keeps them there: for every row the status offers an
       update on, the spec exists and its display is the string the row showed.

       Four provenances against three kinds, because the disagreement was provenance-shaped: fx and
       cursor-agent land in ~/.local/bin (`unknown`), codex may be any of them, and gemini is the
       kind with no updater of its own that the provenance rule still governs. */
    const env = machine([
      { bin: "fx", under: "unknown" }, { bin: "cursor-agent", under: "unknown" },
      { bin: "codex", under: "brew" }, { bin: "gemini", under: "npm" },
    ]);
    const { impl } = fakeFetch({ [CODEX_LATEST]: { version: "0.153.4" }, [GEMINI_LATEST]: { version: "0.9.1" } });
    const svc = new CliService({
      probe: probes([
        { kind: "acp:fx", version: "0.0.7" }, { kind: "acp:cursor", version: "2026.07.25-e42b078" },
        { kind: "codex", version: "codex-cli 0.146.0" }, { kind: "acp:gemini", version: "0.8.0" },
      ]),
      fetchImpl: impl, env,
    });
    const rows = await svc.status();
    const offered = rows.filter((r) => r.action === "update");
    // The kinds above are installed and every one of them has somewhere to go, so an empty list here
    // would make the loop below vacuous rather than passing.
    expect(offered.map((r) => r.kind).sort()).toEqual(["acp:cursor", "acp:fx", "acp:gemini", "codex"]);
    for (const r of offered) {
      expect(updateSpecFor(r.kind, r.provenance, r.latest)?.display, `${r.kind} (${r.provenance})`).toBe(r.command);
    }
    expect(row(rows, "acp:fx").command).toBe("fx upgrade");
  });

  it("upgrades a brew-installed CLI whose route is brew", async () => {
    const env = machine([{ bin: "goose", under: "brew" }]);
    const { impl } = fakeFetch({ [GOOSE_LATEST]: { versions: { stable: "1.9.0" } } });
    const svc = new CliService({ probe: probes([{ kind: "acp:goose", version: "goose 1.8.0" }]), fetchImpl: impl, env });
    const goose = row(await svc.status(), "acp:goose");
    expect(goose.action).toBe("update");
    expect(goose.command).toBe("brew upgrade block-goose-cli");
  });

  it("offers the install command, and no version, for a CLI that is not there", async () => {
    // npm is on this machine — the offer below is one `cli.run` can actually carry out.
    const env = machine([{ bin: "npm", under: "unknown" }]);
    const { impl, urls } = fakeFetch({});
    const svc = new CliService({ probe: probes([{ kind: "codex", available: false, reason: "not found" }]), fetchImpl: impl, env });
    const codex = row(await svc.status(), "codex");
    expect(codex.installed).toBe(false);
    expect(codex.action).toBe("install");
    expect(codex.command).toBe("npm install -g @openai/codex");
    expect(codex.latest).toBe(null);
    // Nothing to update means nothing to ask a registry about.
    expect(urls).toEqual([]);
  });

  it("asks no registry for a script-installed CLI, and offers its own updater instead", async () => {
    // There is no channel to ask, so `latest` stays null and nothing is fetched. That used to be the
    // end of it. cursor-agent ships `cursor-agent update`, so the row is not a dead end after all.
    const env = machine([{ bin: "cursor-agent", under: "npm" }]);
    const { impl, urls } = fakeFetch({});
    const svc = new CliService({ probe: probes([{ kind: "acp:cursor", version: "2026.07.25-e42b078" }]), fetchImpl: impl, env });
    const cursor = row(await svc.status(), "acp:cursor");
    expect(cursor.latest).toBe(null);
    expect(cursor.updateAvailable).toBe(false);
    expect(cursor.action).toBe("update");
    expect(cursor.command).toBe("cursor-agent update");
    expect(urls).toEqual([]);
  });

  it("answers with every row even when the registry is unreachable", async () => {
    const env = machine([{ bin: "codex", under: "npm" }]);
    const dead = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    const svc = new CliService({ probe: probes([{ kind: "codex", version: "codex-cli 0.146.0" }]), fetchImpl: dead, env });
    const codex = row(await svc.status(), "codex");
    expect(codex.installed).toBe(true);
    expect(codex.latest).toBe(null);
    expect(codex.updateAvailable).toBe(false);
  });

  it("does not claim an update when the registry answers an error status", async () => {
    // A 404 (package renamed, registry hiccup) has a body; reading it without checking the status
    // would turn an error page into a version number. Gemini, so that "no claim" is visible as
    // `action: none` rather than hidden behind a vendor updater.
    const env = machine([{ bin: "gemini", under: "npm" }]);
    const { impl } = fakeFetch({});
    const svc = new CliService({ probe: probes([{ kind: "acp:gemini", version: "0.8.0" }]), fetchImpl: impl, env });
    const gemini = row(await svc.status(), "acp:gemini");
    expect(gemini.latest).toBe(null);
    expect(gemini.updateAvailable).toBe(false);
    expect(gemini.action).toBe("none");
  });

});

describe("CliService on a Mac that is missing things", () => {

  it("names Homebrew and uv the same way for the routes that run them", async () => {
    const env = machine([{ bin: "npm", under: "unknown" }]);
    const svc = new CliService({
      probe: probes([{ kind: "acp:goose", available: false }, { kind: "acp:openhands", available: false }]),
      fetchImpl: fakeFetch({}).impl, env,
    });
    const rows = await svc.status();
    expect(row(rows, "acp:goose")).toMatchObject({ action: "none", command: null });
    expect(row(rows, "acp:goose").refusal).toContain("Homebrew isn't on this Mac");
    expect(row(rows, "acp:openhands").refusal).toContain("uv isn't on this Mac");
    // A vendor script needs only curl and bash, so its offer stands with none of the three present.
    expect(row(rows, "acp:cursor")).toMatchObject({ action: "install", refusal: null });
  });

  it("notices Node.js arriving within the probe's thirty seconds, not the registry check's six hours", async () => {
    /* THE MUTANT: look for the tools in the six-hour sweep. Someone who read "Node.js isn't on this
       Mac yet", installed it and came back would still find no Install button for the rest of the
       day. Inside the thirty seconds the cached look stands, which keeps a status call free of fs. */
    const env = machine([]);
    let clock = 0;
    const svc = new CliService({ probe: probes([{ kind: "codex", available: false }]), fetchImpl: fakeFetch({}).impl, env, now: () => clock });
    expect(row(await svc.status(), "codex").action).toBe("none");
    writeFileSync(join(env.PATH, "npm"), "#!/bin/sh\n", { mode: 0o755 });
    clock = 10_000;
    expect(row(await svc.status(), "codex").action).toBe("none");
    clock = 30_001;
    expect(row(await svc.status(), "codex")).toMatchObject({ action: "install", command: "npm install -g @openai/codex", refusal: null });
  });

  it("looks again at once when forced — Settings' Check for updates", async () => {
    const env = machine([]);
    const svc = new CliService({ probe: probes([{ kind: "codex", available: false }]), fetchImpl: fakeFetch({}).impl, env });
    expect(row(await svc.status(), "codex").action).toBe("none");
    writeFileSync(join(env.PATH, "npm"), "#!/bin/sh\n", { mode: 0o755 });
    expect(row(await svc.status({ force: true }), "codex").action).toBe("install");
  });

  it("offers nothing to run for the Claude that comes with Realm, and says why", async () => {
    /* THE MUTANT: treat it like any Claude. The probe answered from the SDK's own binary because
       there is no `claude` on PATH, so the self-updater this row would offer spawns a binary that is
       not there — and Realm's copy is Realm's to update in any case. */
    const env = machine([]);
    const svc = new CliService({ probe: probes([{ kind: "claude", version: "2.1.281 (Claude Code)", loggedIn: true }]), fetchImpl: fakeFetch({}).impl, env });
    const claude = row(await svc.status(), "claude");
    expect(claude).toMatchObject({ installed: true, version: "2.1.281 (Claude Code)", action: "none", command: null, updateAvailable: false });
    expect(claude.refusal).toContain("comes with Realm");
  });

  it("still offers claude's own updater when there IS a claude on PATH", async () => {
    // The other half of the mutant above: every Claude read as Realm's copy, and nobody's own CLI
    // ever offered `claude update` again.
    const env = machine([{ bin: "claude", under: "unknown" }]);
    const svc = new CliService({ probe: probes([{ kind: "claude", version: "2.1.258 (Claude Code)" }]), fetchImpl: fakeFetch({}).impl, env });
    expect(row(await svc.status(), "claude")).toMatchObject({ action: "update", command: "claude update", refusal: null });
  });
});

describe("CliService caching", () => {
  it("asks the registry once per TTL, however many callers ask", async () => {
    const env = machine([{ bin: "codex", under: "npm" }]);
    const { impl, urls } = fakeFetch({ [CODEX_LATEST]: { version: "0.153.4" } });
    const svc = new CliService({ probe: probes([{ kind: "codex", version: "codex-cli 0.146.0" }]), fetchImpl: impl, env });
    await Promise.all([svc.status(), svc.status(), svc.status()]);
    await svc.status();
    expect(urls).toEqual([CODEX_LATEST]);
  });

  it("re-asks past the TTL", async () => {
    const env = machine([{ bin: "codex", under: "npm" }]);
    const { impl, urls } = fakeFetch({ [CODEX_LATEST]: { version: "0.153.4" } });
    let clock = 0;
    const svc = new CliService({ probe: probes([{ kind: "codex", version: "codex-cli 0.146.0" }]), fetchImpl: impl, env, ttlMs: 1000, now: () => clock });
    await svc.status();
    clock = 999;
    await svc.status();
    expect(urls.length).toBe(1);
    clock = 1001;
    await svc.status();
    expect(urls.length).toBe(2);
  });

  it("force re-asks inside the TTL — the gesture after an install finished", async () => {
    const env = machine([{ bin: "codex", under: "npm" }]);
    const { impl, urls } = fakeFetch({ [CODEX_LATEST]: { version: "0.153.4" } });
    const svc = new CliService({ probe: probes([{ kind: "codex", version: "codex-cli 0.146.0" }]), fetchImpl: impl, env });
    await svc.status();
    await svc.status({ force: true });
    expect(urls.length).toBe(2);
    await svc.refresh();
    expect(urls.length).toBe(3);
  });

  it("passes force down to the probe, not only to its own cache", async () => {
    const env = machine([]);
    const forces: (boolean | undefined)[] = [];
    const svc = new CliService({
      probe: async (o) => { forces.push(o.force); return []; },
      fetchImpl: fakeFetch({}).impl, env,
    });
    await svc.status();
    await svc.status({ force: true });
    expect(forces).toEqual([false, true]);
  });
});
