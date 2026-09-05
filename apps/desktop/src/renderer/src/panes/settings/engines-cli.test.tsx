import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PAGE_REF_IDS, type AgentKind, type CliStatus } from "@realm/contracts";
import { SettingsPage } from "./SettingsPage";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, type FakeData } from "../../state/store.test-fakes";
import type { AgentProbe } from "../../state/store";

const pageItem = item("set-s1", "s1", { kind: "settings-page", title: "Settings", refId: PAGE_REF_IDS["settings-page"] });

const installedCodex: AgentProbe[] = [
  { kind: "codex", available: true, version: "0.146.0", loggedIn: true, reason: null },
];

const status = (over: Partial<CliStatus> & { kind: AgentKind }): CliStatus => ({
  installed: true, version: null, binPath: null, provenance: "npm", latest: null, channel: true,
  updateAvailable: false, action: "none", command: null, refusal: null, ...over,
});

/** codex, installed by npm, one release behind — the row that has something to offer. */
const behind = status({
  kind: "codex", version: "codex-cli 0.146.0", provenance: "npm", latest: "0.153.4",
  updateAvailable: true, action: "update", command: "npm install -g @openai/codex@0.153.4",
});

async function mount(overrides: FakeData = {}) {
  const api = fakeApi({ agentProbe: installedCodex, ...overrides });
  const store = createAppStore(api);
  await store.getState().boot();
  const r = render(<StoreContext.Provider value={store}><SettingsPage item={pageItem} visible /></StoreContext.Provider>);
  return { store, api, ...r };
}

afterEach(cleanup);

const codexRow = () => screen.getByRole("listitem", { name: /^Codex:/ });

describe("an engine row with an update available", () => {
  it("says which version is available in the same sentence as the one installed", async () => {
    await mount({ cliStatus: [behind] });
    await waitFor(() => expect(codexRow()).toHaveAccessibleName(/v0\.146\.0 · signed in · v0\.153\.4 available/));
  });

  it("shows the exact command before the button that runs it", async () => {
    await mount({ cliStatus: [behind] });
    await waitFor(() => expect(within(codexRow()).getByText("npm install -g @openai/codex@0.153.4")).toBeInTheDocument());
    expect(within(codexRow()).getByRole("button", { name: "Update" })).toBeInTheDocument();
  });

  it("runs that command only on the click, and streams what it says", async () => {
    const { store, api } = await mount({ cliStatus: [behind] });
    await waitFor(() => within(codexRow()).getByRole("button", { name: "Update" }));
    expect(api.calls.some((c) => c.startsWith("runCli:"))).toBe(false);

    fireEvent.click(within(codexRow()).getByRole("button", { name: "Update" }));
    await waitFor(() => expect(api.calls).toContain("runCli:codex:update"));

    const id = store.getState().cliJobs.codex!.id;
    store.getState().applyCliOutput({ id, kind: "codex", chunk: "changed 1 package\n" });
    await waitFor(() => expect(screen.getByText(/changed 1 package/)).toBeInTheDocument());
    // Nothing may be dismissed while it is still writing to the machine.
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();

    store.getState().applyCliDone({ id, kind: "codex", ok: true, code: 0, error: null });
    await waitFor(() => expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument());
  });

  it("keeps a failure's output on screen with the reason it failed", async () => {
    const { store } = await mount({ cliStatus: [behind] });
    await waitFor(() => within(codexRow()).getByRole("button", { name: "Update" }));
    fireEvent.click(within(codexRow()).getByRole("button", { name: "Update" }));
    await waitFor(() => expect(store.getState().cliJobs.codex).toBeDefined());
    const id = store.getState().cliJobs.codex!.id;
    store.getState().applyCliOutput({ id, kind: "codex", chunk: "npm error EACCES\n" });
    store.getState().applyCliDone({ id, kind: "codex", ok: false, code: 1, error: "exited with code 1" });
    await waitFor(() => expect(screen.getByText(/exited with code 1/)).toBeInTheDocument());
    expect(screen.getByText(/EACCES/)).toBeInTheDocument();
  });
});

describe("an engine row Realm will not update", () => {
  const brewInstalled = status({
    kind: "codex", version: "codex-cli 0.146.0", provenance: "brew", latest: "0.153.4",
    updateAvailable: true, action: "none", command: null,
    refusal: "Installed with Homebrew, so Realm won’t update it with npm — that would leave a second copy on your PATH instead of upgrading this one.",
  });

  it("still says a newer version exists, and says why it is not offering a button", async () => {
    // The named mutant: hiding the update because it cannot be applied. Both halves are the user's.
    await mount({ cliStatus: [brewInstalled] });
    await waitFor(() => expect(codexRow()).toHaveAccessibleName(/v0\.153\.4 available/));
    expect(within(codexRow()).getByText(/Homebrew/)).toBeInTheDocument();
    expect(within(codexRow()).queryByRole("button", { name: "Update" })).toBeNull();
    expect(within(codexRow()).queryByRole("button", { name: "Install" })).toBeNull();
  });
});

describe("an engine row with nothing to offer", () => {
  it("shows a missing CLI's install command with a button that runs it", async () => {
    await mount({
      agentProbe: [{ kind: "codex", available: false, version: null, loggedIn: null, reason: "spawn codex ENOENT" }],
      cliStatus: [status({ kind: "codex", installed: false, action: "install", command: "npm install -g @openai/codex" })],
    });
    await waitFor(() => expect(within(codexRow()).getByText("npm install -g @openai/codex")).toBeInTheDocument());
    expect(within(codexRow()).getByRole("button", { name: "Install" })).toBeInTheDocument();
  });

  it("offers no button for a CLI Realm has no route for, and still explains it", async () => {
    await mount({
      agentProbe: [{ kind: "codex", available: true, version: "0.146.0", loggedIn: false, reason: "not logged in — run `codex login`" }],
      cliStatus: [status({ kind: "codex", action: "none" })],
    });
    const row = await waitFor(() => codexRow());
    // Signing in is a browser flow or an API key, so the command is shown to copy and never run.
    expect(within(row).getByText("codex login")).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "Install" })).toBeNull();
    expect(within(row).queryByRole("button", { name: "Update" })).toBeNull();
  });
});

describe("checking for new models", () => {
  const withModels = (ids: string[]): AgentProbe[] => [{
    kind: "codex", available: true, version: "0.146.0", loggedIn: true, reason: null,
    models: ids.map((id) => ({ id, label: id })),
  }];

  it("forces the live probe and the public catalog, and names what is new", async () => {
    const { api } = await mount({ agentProbe: withModels(["gpt-5.6"]) });
    await waitFor(() => expect(api.calls).toContain("probeAgents:false"));
    api.data.agentProbe = withModels(["gpt-5.6", "gpt-6-astra"]);
    fireEvent.click(screen.getByRole("button", { name: "Check for new models" }));
    await waitFor(() => expect(api.calls).toContain("probeAgents:true"));
    expect(api.calls).toContain("modelCatalog:true");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/New models: Codex gpt-6-astra/));
  });

  it("says nothing-new as an answer rather than saying nothing", async () => {
    const { api } = await mount({ agentProbe: withModels(["gpt-5.6"]) });
    await waitFor(() => expect(api.calls).toContain("probeAgents:false"));
    fireEvent.click(screen.getByRole("button", { name: "Check for new models" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/No new models/));
  });
});
