import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { FILES_OPEN_IN_KEY, PAGE_REF_IDS, POWER_PREVENT_SLEEP_KEY, TERMINALS_DOCK_KEY } from "@realm/contracts";
import { SettingsPage } from "./SettingsPage";
import { SETTINGS_INDEX } from "./settings-index";
import { SETTING_DEFAULT_MODELS, SETTING_LAST_MODELS, StoreContext, createAppStore, type AgentProbe } from "../../state/store";
import { fakeApi, item, type FakeData } from "../../state/store.test-fakes";

const pageItem = item("set-s1", "s1", { kind: "settings-page", title: "Settings", refId: PAGE_REF_IDS["settings-page"] });

async function generalIn(overrides: FakeData = {}) {
  const api = fakeApi(overrides);
  const store = createAppStore(api);
  await store.getState().boot();
  const { unmount } = render(<StoreContext.Provider value={store}><SettingsPage item={pageItem} visible /></StoreContext.Provider>);
  return { api, store, unmount };
}

async function general(overrides: FakeData = {}) {
  const { api, store } = await generalIn(overrides);
  return { api, store };
}

const AWAKE = "Keep the Mac awake while agents work";

describe("Keep the Mac awake while agents work", () => {
  it("is off until asked for, and turning it on reaches main at once as well as the stored row", async () => {
    // A laptop that will not sleep spends a battery nobody agreed to spend. THE default-on mutant.
    const { api, store } = await general();
    expect(screen.getByRole("switch", { name: AWAKE })).not.toBeChecked();
    fireEvent.click(screen.getByRole("switch", { name: AWAKE }));
    await waitFor(() => expect(store.getState().preventSleep).toBe(true));
    expect(api.calls).toContain(`setSetting:${POWER_PREVENT_SLEEP_KEY}=true`);
    // THE stored-only mutant: main hears about it at the next connect, a turn already running stays
    // free to be slept through.
    expect(api.calls).toContain("setPreventSleep:true");
  });

  it("tells main what was saved when the window boots", async () => {
    const { api } = await general({ settings: { [POWER_PREVENT_SLEEP_KEY]: true } });
    expect(screen.getByRole("switch", { name: AWAKE })).toBeChecked();
    expect(api.calls).toContain("setPreventSleep:true");
  });
});

describe("Session terminal", () => {
  const edges = () => within(screen.getByRole("group", { name: "Session terminal" }));

  it("opens on the right until someone moves it, and the choice is written", async () => {
    const { api, store } = await general();
    expect(edges().getByRole("radio", { name: "Right" })).toBeChecked();
    fireEvent.click(edges().getByRole("radio", { name: "Bottom" }));
    await waitFor(() => expect(store.getState().terminalDock).toBe("bottom"));
    expect(api.calls).toContain(`setSetting:${TERMINALS_DOCK_KEY}=bottom`);
  });

  it("renders a saved Bottom, and reads a value it does not know as Right", async () => {
    await general({ settings: { [TERMINALS_DOCK_KEY]: "bottom" } });
    expect(edges().getByRole("radio", { name: "Bottom" })).toBeChecked();
    const api = fakeApi({ settings: { [TERMINALS_DOCK_KEY]: "left" } });
    const store = createAppStore(api);
    await store.getState().boot();
    expect(store.getState().terminalDock).toBe("right");
  });
});

describe("Open files in", () => {
  const select = () => screen.getByRole("combobox", { name: "Open files in" }) as HTMLSelectElement;

  it("lists only the editors this Mac has, the first chosen until someone picks, and Realm for none", async () => {
    const { api, store } = await general({ editors: [{ id: "cursor", name: "Cursor" }, { id: "zed", name: "Zed" }] });
    expect([...select().options].map((o) => o.textContent)).toEqual(["Cursor", "Zed", "Realm"]);
    expect(select().value).toBe("cursor");
    fireEvent.change(select(), { target: { value: "zed" } });
    await waitFor(() => expect(store.getState().openFilesIn).toBe("zed"));
    expect(api.calls).toContain(`setSetting:${FILES_OPEN_IN_KEY}=zed`);
  });

  it("keeps a choice whose editor has gone, and says so, rather than showing another", async () => {
    await general({ editors: [{ id: "cursor", name: "Cursor" }], settings: { [FILES_OPEN_IN_KEY]: "xcode" } });
    expect(select().value).toBe("xcode");
    expect(select().selectedOptions[0]!.textContent).toBe("Xcode — not installed");
  });

  it("on a Mac with none of them, offers no control and says why", async () => {
    // THE disabled-control mutant: draw an empty select, which invites someone to work out how to
    // fill it. Where the owner has said nothing, show nothing — and here, one sentence.
    await general({ editors: [] });
    expect(screen.queryByRole("combobox", { name: "Open files in" })).toBeNull();
    expect(screen.getByText(/none of Cursor, VS Code, Zed or Xcode/)).toBeInTheDocument();
  });
});

describe("Model for new sessions", () => {
  const ready = (kind: AgentProbe["kind"], models: AgentProbe["models"] = null): AgentProbe =>
    ({ kind, available: true, version: "1", loggedIn: true, reason: null, models });
  const codexCatalog = [{ id: "gpt-5.6-sol", label: "GPT-5.6-Sol", isDefault: true }, { id: "gpt-6-luna", label: "GPT-6-Luna" }];
  const row = () => document.querySelector("[data-setting='default-model']") as HTMLElement;
  const model = (agent = "Claude") => screen.getByRole("combobox", { name: `Model for new ${agent} sessions` }) as HTMLSelectElement;
  const texts = (el: HTMLSelectElement) => [...el.options].map((o) => o.textContent);
  const names = () => [...row().querySelectorAll(".settings-row-name")].map((el) => el.textContent);
  const lines = () => [...row().querySelectorAll(".settings-row-desc")].map((el) => el.textContent);

  it("starts on Last used, names the model that is, and lists the models as the picker does", async () => {
    await general({ agentProbe: [ready("claude")], settings: { [SETTING_LAST_MODELS]: { claude: "claude-opus-5-5" } } });
    await waitFor(() => expect(model().value).toBe(""));
    expect(texts(model())).toEqual(["Last used (now Opus 5.5)", "Fable 5.1", "Fable 5", "Opus 5.5", "Opus 5", "Sonnet 5", "Haiku 4.5"]);
    expect(names()).toEqual(["Model for new sessions", "Claude"]);
    expect(lines()).toEqual([]);
  });

  it("names the model the prompter's chip would where nothing was sent yet, where the last send was on the default, and where that model has gone", async () => {
    for (const lastModels of [{}, { claude: null }, { claude: "claude-retired-9" }, { codex: "gpt-6-luna" }]) {
      const { unmount } = await generalIn({ agentProbe: [ready("claude")], settings: { [SETTING_LAST_MODELS]: lastModels } });
      await waitFor(() => expect(model().options[0]!.textContent).toBe("Last used (now Fable 5.1)"));
      unmount();
    }
  });

  it("files a chosen model under its agent, and shows it chosen", async () => {
    const { api, store } = await general({ agentProbe: [ready("claude")] });
    await waitFor(() => expect(model().value).toBe(""));
    fireEvent.change(model(), { target: { value: "claude-sonnet-5" } });
    await waitFor(() => expect(store.getState().defaultModels).toEqual({ claude: "claude-sonnet-5" }));
    expect(api.data.settings[SETTING_DEFAULT_MODELS]).toEqual({ claude: "claude-sonnet-5" });
    expect(model().value).toBe("claude-sonnet-5");
  });

  it("shows a stored choice, and lists what the agent's live catalog lists where it has one", async () => {
    const live = [{ id: "claude-opus-5-5", label: "Claude Opus 5.5", isDefault: true }, { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" }];
    await general({ agentProbe: [ready("claude", live)], settings: { [SETTING_DEFAULT_MODELS]: { claude: "claude-sonnet-5-5" }, [SETTING_LAST_MODELS]: { claude: "claude-opus-5-5" } } });
    await waitFor(() => expect(model().value).toBe("claude-sonnet-5-5"));
    expect(texts(model())).toEqual(["Last used (now Opus 5.5)", "Opus 5.5", "Sonnet 5.5"]);
  });

  it("takes a choice back with Last used, by removing its agent's entry and no other", async () => {
    const { api } = await general({ agentProbe: [ready("claude"), ready("codex", codexCatalog)],
      settings: { [SETTING_DEFAULT_MODELS]: { claude: "claude-sonnet-5", codex: "gpt-6-luna" } } });
    await waitFor(() => expect(model().value).toBe("claude-sonnet-5"));
    fireEvent.change(model(), { target: { value: "" } });
    await waitFor(() => expect(api.data.settings[SETTING_DEFAULT_MODELS]).toEqual({ codex: "gpt-6-luna" }));
    expect(model().value).toBe("");
  });

  it("shows every listed agent's choice at once, each under its agent's name and with its own last model", async () => {
    const { api } = await general({ agentProbe: [ready("claude"), ready("codex", codexCatalog)],
      settings: { "ui.lastAgentKind": "codex", [SETTING_DEFAULT_MODELS]: { codex: "gpt-6-luna" }, [SETTING_LAST_MODELS]: { claude: "claude-opus-5-5", codex: "gpt-5.6-sol" } } });
    await waitFor(() => expect(names()).toEqual(["Model for new sessions", "Claude", "Codex"]));
    expect(row()).toHaveAttribute("data-stack");
    expect(model("Claude").value).toBe("");
    expect(model("Claude").options[0]!.textContent).toBe("Last used (now Opus 5.5)");
    expect(texts(model("Codex"))).toEqual(["Last used (now GPT-5.6-Sol)", "GPT-5.6-Sol", "GPT-6-Luna"]);
    expect(model("Codex").value).toBe("gpt-6-luna");
    fireEvent.change(model("Codex"), { target: { value: "gpt-5.6-sol" } });
    await waitFor(() => expect(api.data.settings[SETTING_DEFAULT_MODELS]).toEqual({ codex: "gpt-5.6-sol" }));
    expect(model("Claude").value).toBe("");
  });

  it("names the agent beside its select where only one is listed, as where several are", async () => {
    await general({ agentProbe: [ready("claude")] });
    await waitFor(() => expect(model()).toBeInTheDocument());
    expect(row()).toHaveAttribute("data-stack");
    expect(model().parentElement).toHaveClass("default-models");
    expect(names()).toEqual(["Model for new sessions", "Claude"]);
  });

  it("keeps a ready agent that lists no models on the row while it holds a choice, so the choice can be seen and taken back", async () => {
    const { api } = await general({ agentProbe: [ready("claude"), ready("codex")], settings: { [SETTING_DEFAULT_MODELS]: { codex: "gpt-6-luna" } } });
    await waitFor(() => expect(model("Codex").value).toBe("gpt-6-luna"));
    expect(texts(model("Codex")).slice(1)).toEqual(["gpt-6-luna"]);
    expect(lines()).toEqual([]);
    fireEvent.change(model("Codex"), { target: { value: "" } });
    await waitFor(() => expect(api.data.settings[SETTING_DEFAULT_MODELS]).toEqual({}));
    await waitFor(() => expect(screen.queryByRole("combobox", { name: "Model for new Codex sessions" })).toBeNull());
    expect(names()).toEqual(["Model for new sessions", "Claude"]);
  });

  it("marks a chosen model that an agent's live list has dropped, after the models it lists, and names what its sessions start on", async () => {
    await general({ agentProbe: [ready("codex", codexCatalog)],
      settings: { [SETTING_DEFAULT_MODELS]: { codex: "gpt-4-retired" }, [SETTING_LAST_MODELS]: { codex: "gpt-6-luna" } } });
    await waitFor(() => expect(model("Codex").value).toBe("gpt-4-retired"));
    expect(texts(model("Codex"))).toEqual(["Last used (now GPT-6-Luna)", "GPT-5.6-Sol", "GPT-6-Luna", "gpt-4-retired — not offered"]);
    expect(lines()).toEqual(["Codex no longer lists gpt-4-retired. New Codex sessions start as they do on Last used (now GPT-6-Luna)."]);
  });

  it("names the agent's own default after Last used where its live list has dropped the model last sent on", async () => {
    await general({ agentProbe: [ready("codex", codexCatalog)], settings: { [SETTING_LAST_MODELS]: { codex: "gpt-4-retired" } } });
    await waitFor(() => expect(model("Codex").options[0]!.textContent).toBe("Last used (now GPT-5.6)"));
  });

  it("keeps a chosen model its agent no longer lists, marks it, and says what new sessions start on instead", async () => {
    await general({ agentProbe: [ready("claude"), ready("codex", codexCatalog)],
      settings: { [SETTING_DEFAULT_MODELS]: { claude: "claude-retired-1", codex: "gpt-6-luna" }, [SETTING_LAST_MODELS]: { claude: "claude-opus-5-5" } } });
    await waitFor(() => expect(model().value).toBe("claude-retired-1"));
    expect(model().selectedOptions[0]!.textContent).toBe("claude-retired-1 — not offered");
    expect(lines()).toEqual(["Claude no longer lists claude-retired-1. New Claude sessions start as they do on Last used (now Opus 5.5)."]);
    expect(texts(model("Codex"))).toEqual(["Last used (now GPT-5.6)", "GPT-5.6-Sol", "GPT-6-Luna"]);
  });

  it("does not call a chosen model gone when the agent lists it and the picker shows it under another id", async () => {
    const twins = [{ id: "gpt-6-luna", label: "GPT-6-Luna" }, { id: "gpt-6-luna-0901", label: "GPT 6 Luna" }];
    await general({ agentProbe: [ready("codex", twins)], settings: { [SETTING_DEFAULT_MODELS]: { codex: "gpt-6-luna" } } });
    await waitFor(() => expect(model("Codex").value).toBe("gpt-6-luna"));
    expect(model("Codex").selectedOptions[0]!.textContent).toBe("gpt-6-luna");
    expect(lines()).toEqual([]);
  });

  it("shows a choice made in another window since this one opened", async () => {
    const api = fakeApi({ agentProbe: [ready("claude")] });
    const store = createAppStore(api);
    await store.getState().boot();
    api.data.settings[SETTING_DEFAULT_MODELS] = { claude: "claude-sonnet-5" };
    render(<StoreContext.Provider value={store}><SettingsPage item={pageItem} visible /></StoreContext.Provider>);
    await waitFor(() => expect(model().value).toBe("claude-sonnet-5"));
  });

  it("lists no agent that is missing, signed out, or without models of its own, and says why when none is left", async () => {
    await general({ agentProbe: [
      { ...ready("claude"), loggedIn: false, reason: "not signed in" },
      { kind: "acp:deepseek", available: false, version: null, loggedIn: null, reason: "not on PATH", models: null },
      ready("codex"),
    ] });
    await waitFor(() => expect(lines()).toEqual(["No agent that is installed and signed in lists its models."]));
    expect(screen.queryByRole("combobox", { name: /^Model for new/ })).toBeNull();
    expect(row().querySelector(".settings-hint")).toBeNull();
  });

  it("does not list an agent the probe said nothing about", async () => {
    await general({ agentProbe: [ready("codex", codexCatalog)] });
    await waitFor(() => expect(model("Codex")).toBeInTheDocument());
    expect(screen.queryByRole("combobox", { name: "Model for new Claude sessions" })).toBeNull();
    expect(names()).toEqual(["Model for new sessions", "Codex"]);
  });

  it("says it is checking until the agents have answered, and not that none lists its models", async () => {
    const api = fakeApi({ agentProbe: [] });
    api.probeAgents = () => new Promise(() => {});
    const store = createAppStore(api);
    await store.getState().boot();
    render(<StoreContext.Provider value={store}><SettingsPage item={pageItem} visible /></StoreContext.Provider>);
    expect(within(row()).getByText("Checking the installed agents…")).toBeInTheDocument();
    expect(lines()).toEqual([]);
  });

  it("says it is still checking beside an agent that has already answered", async () => {
    const api = fakeApi({ agentProbe: [ready("claude")] });
    api.probeAgents = () => new Promise(() => {});
    const store = createAppStore(api);
    await store.getState().boot();
    await store.getState().probeAgent("claude");
    render(<StoreContext.Provider value={store}><SettingsPage item={pageItem} visible /></StoreContext.Provider>);
    const checking = within(row()).getByText("Checking the installed agents…");
    expect(model()).toBeInTheDocument();
    expect(row().querySelector(".default-models")!.compareDocumentPosition(checking) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("sits with the other rows about new sessions", async () => {
    await general({ agentProbe: [ready("claude")] });
    await waitFor(() => expect(model()).toBeInTheDocument());
    expect(row().parentElement).toBe(document.querySelector("[data-setting='default-permission']")!.parentElement);
  });

  it("is named on the page as Settings search names it", async () => {
    await general({ agentProbe: [ready("claude")] });
    await waitFor(() => expect(model()).toBeInTheDocument());
    expect(names()[0]).toBe(SETTINGS_INDEX.find((e) => e.id === "default-model")!.label);
  });

  it("says under the selects which sessions the row reaches and which it leaves alone, and on each select what Last used follows", async () => {
    await general({ agentProbe: [ready("claude"), ready("codex", codexCatalog)] });
    await waitFor(() => expect(model()).toBeInTheDocument());
    const hint = row().querySelector(".settings-hint");
    expect(hint?.textContent).toBe("Applies to a session you start with ⌘N, a split, a new worktree, or a new space. A palette command that names an agent, the quick chat, and a question about a file start on the agent's own default.");
    expect(row().lastElementChild).toBe(hint);
    expect(row()).not.toHaveAttribute("title");
    expect(model()).toHaveAttribute("title", "Last used follows the last message you sent on Claude, not counting the quick chat or a question about a file or pull request.");
    expect(model("Codex")).toHaveAttribute("title", "Last used follows the last message you sent on Codex, not counting the quick chat or a question about a file or pull request.");
  });
});
