import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PAGE_REF_IDS, type AgentKind, type CliStatus } from "@realm/contracts";
import { SettingsPage } from "./SettingsPage";
import { StoreContext, createAppStore } from "../../state/store";
import { claudeFolder, fakeApi, item, type FakeData } from "../../state/store.test-fakes";
import type { AgentProbe } from "../../state/store";

const pageItem = item("set-s1", "s1", { kind: "settings-page", title: "Settings", refId: PAGE_REF_IDS["settings-page"] });

const installedCodex: AgentProbe[] = [
  { kind: "codex", available: true, version: "0.146.0", loggedIn: true, reason: null },
];

const status = (over: Partial<CliStatus> & { kind: AgentKind }): CliStatus => ({
  installed: true, version: null, binPath: null, provenance: "npm", latest: null,
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
  fireEvent.click(screen.getByRole("radio", { name: "Engines" }));
  return { store, api, ...r };
}

afterEach(cleanup);

const codexRow = () => screen.getByRole("listitem", { name: /^Codex:/ });

describe("an engine row with an update available", () => {
  it("says which version is available beside the one installed", async () => {
    /* These were one sentence in the card's accessible name. They are separate chips now, which is
       the point of the redesign: "which version am I on" and "is there a newer one" are two
       questions, and welding them meant reading the whole string to answer either. */
    await mount({ cliStatus: [behind] });
    await waitFor(() => expect(within(codexRow()).getByText("v0.146.0")).toBeInTheDocument());
    expect(within(codexRow()).getByText("Signed in")).toBeInTheDocument();
    // The available version moved out of the chip row and onto the ACTION: a chip saying a newer
    // version exists, with nothing beside it to do about it, is a dead end. The button NAMES that
    // version, because the same button also appears when nothing newer is known — a CLI with its own
    // updater always offers to go and look — and there it reads "Check for updates" instead.
    expect(within(codexRow()).getByRole("button", { name: "Update to v0.153.4" })).toBeInTheDocument();
  });

  it("runs that command only on the click, and streams what it says", async () => {
    const { store, api } = await mount({ cliStatus: [behind] });
    await waitFor(() => within(codexRow()).getByRole("button", { name: "Update to v0.153.4" }));
    expect(api.calls.some((c) => c.startsWith("runCli:"))).toBe(false);

    fireEvent.click(within(codexRow()).getByRole("button", { name: "Update to v0.153.4" }));
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
    await waitFor(() => within(codexRow()).getByRole("button", { name: "Update to v0.153.4" }));
    fireEvent.click(within(codexRow()).getByRole("button", { name: "Update to v0.153.4" }));
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
    binPath: "/opt/homebrew/bin/codex", updateAvailable: true, action: "none", command: null,
    refusal: "Installed with Homebrew, so Realm won’t update it with npm — that would leave a second copy on your PATH instead of upgrading this one.",
  });

  it("still says a newer version exists, and says why it is not offering a button", async () => {
    // The named mutant: hiding the update because it cannot be applied. Both halves are the user's.
    /* Realm will not run npm over a Homebrew install — that leaves a second copy on the PATH. It
       still offers a BUTTON, because "there is a newer version" with no affordance is a dead end;
       that button opens the card's own details, which hold the command and the reason. */
    const { api } = await mount({ cliStatus: [brewInstalled] });
    const button = await waitFor(() => within(codexRow()).getByRole("button", { name: "Update to v0.153.4" }));
    // With the copy it means: "which one?" is the next question for anyone with two on their PATH.
    expect(within(codexRow()).getByText(/Homebrew.*\/opt\/homebrew\/bin\/codex/)).toBeInTheDocument();
    /* The distinction the refusal is about, asserted on BEHAVIOUR rather than on the label. It used
       to be that this button read "Update to v…" and the one that runs an update read plain
       "Update"; the runner names its version now, so the two labels are the same string and only
       what the click does tells them apart. Which is the honest test either way. */
    fireEvent.click(button);
    expect(api.calls.some((c) => c.startsWith("runCli:"))).toBe(false);
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
    expect(within(row).queryByRole("button", { name: "Update to v0.153.4" })).toBeNull();
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

/** A Claude config folder under the fake's home (`/Users/carlton`), which the page writes with `~`. */
const WORK = "/Users/carlton/.claude-work";
const claudeCard = () => screen.getByRole("listitem", { name: /^Claude:/ });
/** The line on Claude's card that says which folder the profile signs in from, or null. */
const folderLine = () => claudeCard().querySelector('[data-setting="engine-claude-folder"]');
/** Claude Code installed and signed out, as its row reads for `home` (null for the default folder). */
const signedOut = (home: string | null): AgentProbe[] => [{ kind: "claude", available: true, version: "2.1.296", loggedIn: false, reason: null, home }];

describe("Claude's card, where the active profile names a Claude config folder", () => {
  it("says which folder the profile signs in from, with the folder in mono and ~ for home", async () => {
    await mount({ claudeDirs: { p1: claudeFolder(WORK) } });
    await waitFor(() => expect(folderLine()?.querySelector("span")?.textContent).toBe("Work signs in from ~/.claude-work."));
    expect(within(claudeCard()).getByText("~/.claude-work").tagName).toBe("CODE");
  });

  it("opens the profile's own page on General from Change…", async () => {
    const { store } = await mount({ claudeDirs: { p1: claudeFolder(WORK) } });
    fireEvent.click(await screen.findByRole("button", { name: "Change…" }));
    expect(store.getState().pageOverlay).toMatchObject({ kind: "profile-page", spaceId: store.getState().activeSpaceId });
    expect(store.getState().profilePageTab).toEqual({ p1: "general" });
  });

  it("draws no such line, and no Change…, while the profile names no folder", async () => {
    const { store } = await mount();
    await waitFor(() => expect(store.getState().claudeDirs.p1).toEqual(claudeFolder(null)));
    await waitFor(() => expect(claudeCard()).toBeInTheDocument());
    expect(folderLine()).toBeNull();
    expect(screen.queryByRole("button", { name: "Change…" })).toBeNull();
  });

  it("draws no such line, and no Change…, under a variable that outranks the folder's sign-in", async () => {
    const { store } = await mount({ claudeDirs: { p1: claudeFolder(WORK, { override: "ANTHROPIC_API_KEY" }) } });
    await waitFor(() => expect(store.getState().claudeDirs.p1?.override).toBe("ANTHROPIC_API_KEY"));
    await waitFor(() => expect(claudeCard()).toBeInTheDocument());
    expect(folderLine()).toBeNull();
    expect(screen.queryByRole("button", { name: "Change…" })).toBeNull();
  });
});

describe("Claude's card, signed out", () => {
  it("offers the line that signs the named folder in, never the bare one, and says where that sign-in is kept", async () => {
    await mount({ agentProbe: signedOut(WORK), claudeDirs: { p1: claudeFolder(WORK) } });
    const card = await screen.findByRole("listitem", { name: "Claude: Signed out" });
    expect(within(card).getByText(`env CLAUDE_CONFIG_DIR='${WORK}' claude auth login`)).toBeInTheDocument();
    expect(within(card).queryByText("claude auth login")).toBeNull();
    expect(within(card).getByText(`Uses the \`claude\` login kept in ${WORK}. Sign in there if sessions fail to authenticate.`)).toBeInTheDocument();
    expect(within(card).queryByText(/run `claude auth login`/)).toBeNull();
  });

  it("keeps the table's own line and sentence on the default folder", async () => {
    await mount({ agentProbe: signedOut(null) });
    const card = await screen.findByRole("listitem", { name: "Claude: Signed out" });
    expect(within(card).getByText("claude auth login")).toBeInTheDocument();
    expect(within(card).getByText("Uses your `claude` login — run `claude auth login` if sessions fail to authenticate.")).toBeInTheDocument();
  });
});

/** What the server says of a named folder that is gone, in place of asking Claude Code about it. */
const REASON = "The Claude config folder ~/.claude-work is missing.";
/** Work naming that folder, and Claude's row for it: signed out, as the server reads a folder
 *  nothing can be signed in to. Made anew for each test, since the fake keeps what it is handed. */
const gone = (): FakeData => ({
  agentProbe: [{ kind: "claude", available: true, version: "2.1.296", loggedIn: false, reason: REASON, home: WORK, homeMissing: true }],
  claudeDirs: { p1: claudeFolder(WORK, { missing: true }) },
});

describe("Claude's card, where the folder the profile names is missing", () => {
  it("offers no line to copy, which would have Claude Code make the folder", async () => {
    await mount(gone());
    const card = await screen.findByRole("listitem", { name: "Claude: Signed out" });
    expect(within(card).queryByText(/claude auth login/)).toBeNull();
    expect(within(card).queryByRole("button", { name: "Copy command" })).toBeNull();
  });

  it("says nothing of where a sign-in is kept, and prints the row's reason once", async () => {
    await mount(gone());
    const card = await screen.findByRole("listitem", { name: "Claude: Signed out" });
    expect(within(card).queryByText(/Sign in there if sessions fail to authenticate/)).toBeNull();
    expect(within(card).getAllByText(REASON)).toHaveLength(1);
  });

  it("prints that reason once where the row also says Claude Code is not installed", async () => {
    const away = gone();
    await mount({ ...away, agentProbe: away.agentProbe?.map((row) => ({ ...row, available: false, version: null })) });
    const card = await screen.findByRole("listitem", { name: "Claude: Not installed" });
    expect(within(card).getAllByText(REASON)).toHaveLength(1);
  });
});
