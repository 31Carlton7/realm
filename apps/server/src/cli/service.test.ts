import { tempDir } from "@realm/test-utils";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProbeResult } from "@realm/adapters";
import type { AgentKind } from "@realm/contracts";
import { CliService } from "./service";


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

  it("updates a brew-installed CLI WITH brew, even though its canonical route is npm", async () => {
    /* This used to refuse. The refusal was half right — `npm install -g` really would leave a second
       copy on the PATH — and wholly unhelpful: a plain `brew install` became a permanent "there is a
       newer version and Realm will not fetch it". The rule is match the PROVENANCE, not the
       canonical route, so a Homebrew install upgrades with Homebrew. */
    const env = machine([{ bin: "gemini", under: "brew" }]);
    const { impl } = fakeFetch({ [GEMINI_LATEST]: { version: "0.9.1" } });
    const svc = new CliService({ probe: probes([{ kind: "acp:gemini", version: "0.8.0" }]), fetchImpl: impl, env });
    const gemini = row(await svc.status(), "acp:gemini");
    expect(gemini.updateAvailable).toBe(true);
    expect(gemini.provenance).toBe("brew");
    // No formula is published for gemini, so brew provenance has nothing to upgrade WITH: the
    // refusal survives, and it is about this kind rather than about Homebrew.
    expect(gemini.action).toBe("none");
    expect(gemini.refusal).toContain("Homebrew");
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

  it("still offers the vendor updater when nothing newer is KNOWN — which is not the same as up to date", async () => {
    /* `updateAvailable` stays false, so no row claims an update is waiting. The button is there
       because the CLI's own updater resolves latest against the vendor's channel at the moment it
       runs, and that channel is not the npm registry Realm watches — for cursor-agent it is the only
       channel there is. */
    const env = machine([{ bin: "codex", under: "npm" }]);
    const { impl } = fakeFetch({ [CODEX_LATEST]: { version: "0.146.0" } });
    const svc = new CliService({ probe: probes([{ kind: "codex", version: "codex-cli 0.146.0" }]), fetchImpl: impl, env });
    const codex = row(await svc.status(), "codex");
    expect(codex.updateAvailable).toBe(false);
    expect(codex.action).toBe("update");
    expect(codex.command).toBe("codex update");
    expect(codex.refusal).toBe(null);
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
    const env = machine([]);
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

  it("never offers to install the compiled-in fake adapter", async () => {
    const svc = new CliService({ probe: probes([{ kind: "fake", available: false }]), fetchImpl: fakeFetch({}).impl, env: machine([]) });
    const fake = row(await svc.status(), "fake");
    expect(fake.action).toBe("none");
    expect(fake.command).toBe(null);
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

  it("does not claim an update when the registry answers a shape it does not understand", async () => {
    const env = machine([{ bin: "codex", under: "npm" }]);
    const { impl } = fakeFetch({ [CODEX_LATEST]: { latest: "0.153.4" } });
    const svc = new CliService({ probe: probes([{ kind: "codex", version: "codex-cli 0.146.0" }]), fetchImpl: impl, env });
    expect(row(await svc.status(), "codex").updateAvailable).toBe(false);
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
