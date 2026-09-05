import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProbeResult } from "@realm/adapters";
import type { AgentKind } from "@realm/contracts";
import { CliService } from "./service";

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

/** A PATH directory holding the named binaries, each a symlink into the layout its package manager
 *  would have produced. No package manager is ever run — the layout IS the fact under test. */
function machine(installs: { bin: string; under: "npm" | "brew" }[]): { PATH: string } {
  const root = mkdtempSync(join(tmpdir(), "realm-clisvc-"));
  roots.push(root);
  const binDir = join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  for (const { bin, under } of installs) {
    const real = under === "brew"
      ? join(root, "Cellar", bin, "1.0.0", "bin", bin)
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

function probes(rows: Partial<ProbeResult>[]): (o: { force?: boolean }) => Promise<ProbeResult[]> {
  return async () => rows.map((r) => ({ kind: "fake" as AgentKind, available: true, version: null, loggedIn: null, reason: null, ...r }));
}

const row = (rows: Awaited<ReturnType<CliService["status"]>>, kind: AgentKind) => rows.find((r) => r.kind === kind)!;

describe("CliService.status", () => {
  it("offers an update when the registry is ahead of an npm install", async () => {
    const env = machine([{ bin: "codex", under: "npm" }]);
    const { impl } = fakeFetch({ [CODEX_LATEST]: { version: "0.153.4" } });
    const svc = new CliService({ probe: probes([{ kind: "codex", version: "codex-cli 0.146.0" }]), fetchImpl: impl, env });
    const codex = row(await svc.status(), "codex");
    expect(codex.updateAvailable).toBe(true);
    expect(codex.action).toBe("update");
    expect(codex.command).toBe("npm install -g @openai/codex@0.153.4");
    expect(codex.provenance).toBe("npm");
    expect(codex.refusal).toBe(null);
  });

  it("offers nothing when the installed version is already the published one", async () => {
    const env = machine([{ bin: "codex", under: "npm" }]);
    const { impl } = fakeFetch({ [CODEX_LATEST]: { version: "0.146.0" } });
    const svc = new CliService({ probe: probes([{ kind: "codex", version: "codex-cli 0.146.0" }]), fetchImpl: impl, env });
    const codex = row(await svc.status(), "codex");
    expect(codex.updateAvailable).toBe(false);
    expect(codex.action).toBe("none");
    expect(codex.command).toBe(null);
    expect(codex.latest).toBe("0.146.0");
  });

  it("reports an update it will not apply, rather than hiding either half", async () => {
    // codex installed by Homebrew: npm install -g would add a second copy, so the update is named
    // and refused in the same row.
    const env = machine([{ bin: "codex", under: "brew" }]);
    const { impl } = fakeFetch({ [CODEX_LATEST]: { version: "0.153.4" } });
    const svc = new CliService({ probe: probes([{ kind: "codex", version: "codex-cli 0.146.0" }]), fetchImpl: impl, env });
    const codex = row(await svc.status(), "codex");
    expect(codex.updateAvailable).toBe(true);
    expect(codex.provenance).toBe("brew");
    expect(codex.action).toBe("none");
    expect(codex.command).toBe(null);
    expect(codex.refusal).toContain("Homebrew");
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

  it("says a script-installed CLI has no version channel and offers no update", async () => {
    const env = machine([{ bin: "cursor-agent", under: "npm" }]);
    const { impl, urls } = fakeFetch({});
    const svc = new CliService({ probe: probes([{ kind: "acp:cursor", version: "2026.09.01" }]), fetchImpl: impl, env });
    const cursor = row(await svc.status(), "acp:cursor");
    expect(cursor.channel).toBe(false);
    expect(cursor.latest).toBe(null);
    expect(cursor.action).toBe("none");
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
    // would turn an error page into a version number.
    const env = machine([{ bin: "codex", under: "npm" }]);
    const { impl } = fakeFetch({});
    const svc = new CliService({ probe: probes([{ kind: "codex", version: "codex-cli 0.146.0" }]), fetchImpl: impl, env });
    const codex = row(await svc.status(), "codex");
    expect(codex.latest).toBe(null);
    expect(codex.updateAvailable).toBe(false);
    expect(codex.action).toBe("none");
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
