import { describe, expect, it } from "vitest";
import type { AgentKind, CliStatus } from "@realm/contracts";
import { createAppStore } from "./store";
import { fakeApi, profile, space, type FakeApi } from "./store.test-fakes";

const tick = () => new Promise((r) => setTimeout(r, 0));

const status = (over: Partial<CliStatus> & { kind: AgentKind }): CliStatus => ({
  installed: true, version: null, binPath: null, provenance: "npm", latest: null,
  updateAvailable: false, action: "none", command: null, refusal: null, ...over,
});

function booted(over: Parameters<typeof fakeApi>[0] = {}): Promise<{ a: FakeApi; store: ReturnType<typeof createAppStore> }> {
  const a = fakeApi({ profiles: [profile("p1", "P")], spaces: [space("s1", "p1", "S")], ...over });
  const store = createAppStore(a);
  return store.getState().boot().then(() => ({ a, store }));
}

describe("cli status", () => {
  it("checks on launch, unforced, without boot waiting for it", async () => {
    // The whole cadence rule: launch LOOKS. It must ride the server's cache (unforced) and must not
    // be awaited by boot, or a slow registry becomes a slow first paint.
    const { a, store } = await booted({ cliStatus: [status({ kind: "codex" })] });
    expect(store.getState().booted).toBe(true);
    await tick();
    expect(a.calls).toContain("cliStatus:false");
    expect(a.calls).not.toContain("cliStatus:true");
    expect(store.getState().cliStatus).toHaveLength(1);
  });

  it("launch never runs an install, whatever the rows say", async () => {
    // The named mutant: a launch path that "helpfully" applies what it found. Every row here is
    // offering something, and none of it may be taken up without a click.
    const { a } = await booted({
      cliStatus: [
        status({ kind: "codex", action: "update", updateAvailable: true, latest: "9.9.9", command: "npm install -g @openai/codex@9.9.9" }),
        status({ kind: "acp:goose", installed: false, action: "install", command: "brew install block-goose-cli" }),
      ],
    });
    await tick();
    expect(a.calls.some((c) => c.startsWith("runCli:"))).toBe(false);
  });

  it("forces past both caches when the user asks to check", async () => {
    const { a, store } = await booted();
    await store.getState().refreshCliStatus(true);
    expect(a.calls).toContain("cliStatus:true");
  });

  it("collapses a mount storm, but a cheap call never satisfies a forced one", async () => {
    const { a, store } = await booted();
    await tick(); // let the launch check settle, so what follows is only this test's calls
    a.delays["cliStatus"] = 10;
    a.calls.length = 0;
    await Promise.all([store.getState().refreshCliStatus(), store.getState().refreshCliStatus(), store.getState().refreshCliStatus(true)]);
    expect(a.calls.filter((c) => c === "cliStatus:false")).toHaveLength(1);
    expect(a.calls.filter((c) => c === "cliStatus:true")).toHaveLength(1);
  });
});

describe("running an install", () => {
  const offering = [status({ kind: "codex", installed: false, action: "install", command: "npm install -g @openai/codex" })];

  it("holds the command the server says is running, not the one the button rendered", async () => {
    const { store } = await booted({ cliStatus: offering });
    await store.getState().runCliAction("codex", "install");
    expect(store.getState().cliJobs.codex).toMatchObject({
      command: "npm install -g @openai/codex", state: "running", output: "", error: null,
    });
  });

  it("refuses an action the server is not offering", async () => {
    const { store } = await booted({ cliStatus: [status({ kind: "codex", action: "none" })] });
    // The refusal is the SERVER's: `runCliAction` carries no guard of its own, deliberately, so that
    // what is on offer is decided in exactly one place. What the renderer owes is the half below —
    // a rejected call leaves no job row behind for a panel to render as running. Matching on the
    // message would pin prose belonging to the fake rather than anything production does.
    await expect(store.getState().runCliAction("codex", "install")).rejects.toThrow();
    expect(store.getState().cliJobs.codex).toBeUndefined();
  });

  it("rejoins output split at arbitrary byte boundaries", async () => {
    const { store } = await booted({ cliStatus: offering });
    await store.getState().runCliAction("codex", "install");
    const id = store.getState().cliJobs.codex!.id;
    store.getState().applyCliOutput({ id, kind: "codex", chunk: "added 1 pac" });
    store.getState().applyCliOutput({ id, kind: "codex", chunk: "kage\n" });
    expect(store.getState().cliJobs.codex!.output).toBe("added 1 package\n");
  });

  it("ignores output and outcomes from a job it did not start", async () => {
    // These events are broadcast to every window, so a second Realm window's install arrives here too.
    const { store } = await booted({ cliStatus: offering });
    await store.getState().runCliAction("codex", "install");
    store.getState().applyCliOutput({ id: "someone-else", kind: "codex", chunk: "not mine" });
    store.getState().applyCliDone({ id: "someone-else", kind: "codex", ok: false, code: 1, error: "not mine" });
    expect(store.getState().cliJobs.codex).toMatchObject({ output: "", state: "running" });
  });

  it("records how it ended, keeping the output that explains it", async () => {
    const { store } = await booted({ cliStatus: offering });
    await store.getState().runCliAction("codex", "install");
    const id = store.getState().cliJobs.codex!.id;
    store.getState().applyCliOutput({ id, kind: "codex", chunk: "npm error EACCES\n" });
    store.getState().applyCliDone({ id, kind: "codex", ok: false, code: 1, error: "exited with code 1" });
    expect(store.getState().cliJobs.codex).toMatchObject({ state: "failed", error: "exited with code 1" });
    expect(store.getState().cliJobs.codex!.output).toContain("EACCES");
  });

  it("will not dismiss a job that is still running", async () => {
    // Hiding a package manager's output while it is still writing to the machine is the one moment
    // that output matters most.
    const { store } = await booted({ cliStatus: offering });
    await store.getState().runCliAction("codex", "install");
    store.getState().dismissCliJob("codex");
    expect(store.getState().cliJobs.codex).toBeDefined();
    const id = store.getState().cliJobs.codex!.id;
    store.getState().applyCliDone({ id, kind: "codex", ok: true, code: 0, error: null });
    store.getState().dismissCliJob("codex");
    expect(store.getState().cliJobs.codex).toBeUndefined();
  });
});

describe("checking for new models", () => {
  const withModels = (ids: string[]) => [{
    kind: "codex" as AgentKind, available: true, version: "codex-cli 1.0.0", loggedIn: true, reason: null,
    models: ids.map((id) => ({ id, label: id })),
  }];

  it("forces both existing seams — the live probe and the public catalog", async () => {
    const { a, store } = await booted({ agentProbe: withModels(["gpt-5.6"]) });
    a.calls.length = 0;
    await store.getState().checkForNewModels();
    expect(a.calls).toContain("probeAgents:true");
    expect(a.calls).toContain("modelCatalog:true");
  });

  it("names the ids the provider started reporting", async () => {
    const { a, store } = await booted({ agentProbe: withModels(["gpt-5.6"]) });
    await store.getState().probeAgents();
    a.data.agentProbe = withModels(["gpt-5.6", "gpt-6-astra"]);
    await store.getState().checkForNewModels();
    expect(store.getState().modelCheck!.added).toEqual([{ kind: "codex", id: "gpt-6-astra", label: "gpt-6-astra" }]);
  });

  it("reports nothing new as nothing new, not as no answer", async () => {
    const { store } = await booted({ agentProbe: withModels(["gpt-5.6"]) });
    await store.getState().probeAgents();
    await store.getState().checkForNewModels();
    expect(store.getState().modelCheck).toMatchObject({ added: [] });
  });

  it("does not call a first-ever enumeration 'new'", async () => {
    // The named mutant: treating an absent previous list as an empty one, which would announce a
    // provider's entire catalog as newly published the first time Realm managed to ask.
    const a = fakeApi({ profiles: [profile("p1", "P")], spaces: [space("s1", "p1", "S")], agentProbe: withModels(["a", "b", "c"]) });
    const store = createAppStore(a);
    await store.getState().boot();
    // agentProbe has never been read, so there is no previous answer to diff against.
    expect(store.getState().agentProbe).toEqual([]);
    await store.getState().checkForNewModels();
    expect(store.getState().modelCheck!.added).toEqual([]);
  });

  it("ignores a kind that cannot enumerate rather than reading it as empty", async () => {
    const { a, store } = await booted({ agentProbe: withModels(["gpt-5.6"]) });
    await store.getState().probeAgents();
    a.data.agentProbe = [{ kind: "codex", available: true, version: "codex-cli 1.0.0", loggedIn: true, reason: null, models: null }];
    await store.getState().checkForNewModels();
    expect(store.getState().modelCheck!.added).toEqual([]);
  });
});
