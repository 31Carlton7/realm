import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { CLAUDE_OWN_SETUP_COPY, CLAUDE_OWN_SETUP_KEY, FILES_OPEN_IN_KEY, PAGE_REF_IDS, POWER_PREVENT_SLEEP_KEY, TERMINALS_DOCK_KEY } from "@realm/contracts";
import { SettingsPage } from "./SettingsPage";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, type FakeData } from "../../state/store.test-fakes";

const pageItem = item("set-s1", "s1", { kind: "settings-page", title: "Settings", refId: PAGE_REF_IDS["settings-page"] });

async function general(overrides: FakeData = {}) {
  const api = fakeApi(overrides);
  const store = createAppStore(api);
  await store.getState().boot();
  render(<StoreContext.Provider value={store}><SettingsPage item={pageItem} visible /></StoreContext.Provider>);
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

/** The switch's name. The server acts on this setting, and only on a stored JSON `true`, so the page
 *  has to read and write that same value: a switch that showed on for anything else would claim a
 *  session keeps a setup the server is still shutting out. */
const OWN_SETUP = CLAUDE_OWN_SETUP_COPY.label;

describe("Use my Claude Code setup", () => {
  it("is off until someone turns it on", async () => {
    const { store } = await general();
    expect(await screen.findByRole("switch", { name: OWN_SETUP })).not.toBeChecked();
    expect(store.getState().settingsPrefs?.claudeOwnSetup).toBe(false);
  });

  it("writes true under its own key when it is turned on, and stays on", async () => {
    const { api } = await general();
    fireEvent.click(await screen.findByRole("switch", { name: OWN_SETUP }));
    await waitFor(() => expect(api.data.settings[CLAUDE_OWN_SETUP_KEY]).toBe(true));
    await waitFor(() => expect(screen.getByRole("switch", { name: OWN_SETUP })).toBeChecked());
  });

  it("renders a stored on as on, and turning it off writes false rather than forgetting the key", async () => {
    const { api } = await general({ settings: { [CLAUDE_OWN_SETUP_KEY]: true } });
    const sw = await screen.findByRole("switch", { name: OWN_SETUP });
    expect(sw).toBeChecked();
    fireEvent.click(sw);
    await waitFor(() => expect(api.data.settings[CLAUDE_OWN_SETUP_KEY]).toBe(false));
  });

  it("reads off once it is turned off", async () => {
    const { store } = await general({ settings: { [CLAUDE_OWN_SETUP_KEY]: true } });
    fireEvent.click(await screen.findByRole("switch", { name: OWN_SETUP }));
    await waitFor(() => expect(store.getState().settingsPrefs?.claudeOwnSetup).toBe(false));
    await waitFor(() => expect(screen.getByRole("switch", { name: OWN_SETUP })).not.toBeChecked());
  });

  it("reads a stored value that is not a JSON true as off, as the server does", async () => {
    await general({ settings: { [CLAUDE_OWN_SETUP_KEY]: "true" } });
    expect(await screen.findByRole("switch", { name: OWN_SETUP })).not.toBeChecked();
  });

  it("sits under Sessions in the group that holds New sessions start in", async () => {
    await general();
    const row = (await screen.findByRole("switch", { name: OWN_SETUP })).closest(".settings-row") as HTMLElement;
    expect(row).toHaveAttribute("data-setting", "claude-own-setup");
    expect(row.parentElement!.previousElementSibling).toHaveTextContent("Sessions");
    expect(row.parentElement!.querySelector('[data-setting="default-permission"]')).not.toBeNull();
  });

  it("says what Claude sessions load from the person's own setup", async () => {
    await general();
    const row = within((await screen.findByRole("switch", { name: OWN_SETUP })).closest(".settings-row") as HTMLElement);
    expect(row.getByText(CLAUDE_OWN_SETUP_COPY.label)).toBeInTheDocument();
    expect(row.getByText(CLAUDE_OWN_SETUP_COPY.detail).textContent).toMatch(/Claude sessions also load your Claude Code settings, hooks, plugins, skills, and MCP servers/);
  });

  it("says the ones in the folder a session runs in load too", async () => {
    await general();
    const row = within((await screen.findByRole("switch", { name: OWN_SETUP })).closest(".settings-row") as HTMLElement);
    expect(row.getByText(CLAUDE_OWN_SETUP_COPY.detail).textContent).toMatch(/and the ones in the folder they run in\./);
  });

  it("says the permission rules in those files are not used, and where they are after all", async () => {
    await general();
    const row = within((await screen.findByRole("switch", { name: OWN_SETUP })).closest(".settings-row") as HTMLElement);
    expect(row.getByText(CLAUDE_OWN_SETUP_COPY.detail).textContent).toMatch(/Permission rules in those files aren't used, unless your organization manages Claude Code's settings\./);
  });

  it("says when a change applies", async () => {
    await general();
    const row = within((await screen.findByRole("switch", { name: OWN_SETUP })).closest(".settings-row") as HTMLElement);
    expect(row.getByText(CLAUDE_OWN_SETUP_COPY.detail).textContent).toMatch(/A change applies when a session's agent next starts/);
  });

  it("says a change never applies to a browser agent's session", async () => {
    await general();
    const row = within((await screen.findByRole("switch", { name: OWN_SETUP })).closest(".settings-row") as HTMLElement);
    expect(row.getByText(CLAUDE_OWN_SETUP_COPY.detail).textContent).toMatch(/and never to a browser agent's session\./);
  });

  it("says an MCP server named in the folder's .mcp.json starts without Claude Code's approval prompt", async () => {
    await general();
    const row = within((await screen.findByRole("switch", { name: OWN_SETUP })).closest(".settings-row") as HTMLElement);
    expect(row.getByText(CLAUDE_OWN_SETUP_COPY.detail).textContent).toMatch(/An MCP server named in that folder's \.mcp\.json starts without Claude Code's approval prompt\./);
  });
});

/** The General page with its preferences loaded, for the tests that change two of them with no wait
 *  between the two. The second change is then asked for while the first is still on its way to the
 *  server, and each answer has to write its own field over the preferences held when it lands. An
 *  answer written over what was read before asking puts the other change back, and the window then
 *  shows a value the server no longer stores. */
async function generalLoaded() {
  const { store } = await general();
  await screen.findByRole("switch", { name: OWN_SETUP });
  return store;
}

describe("a setting changed while another change is still on its way to the server", () => {
  it("leaves Use my Claude Code setup on when New sessions start in is answered after it", async () => {
    const store = await generalLoaded();
    const { setClaudeOwnSetup, setDefaultPermissionMode } = store.getState();
    await Promise.all([setClaudeOwnSetup(true), setDefaultPermissionMode("acceptEdits")]);
    expect(store.getState().settingsPrefs).toMatchObject({ claudeOwnSetup: true, defaultPermissionMode: "acceptEdits" });
  });

  it("leaves New sessions start in as chosen when Use my Claude Code setup is answered after it", async () => {
    const store = await generalLoaded();
    const { setClaudeOwnSetup, setDefaultPermissionMode } = store.getState();
    await Promise.all([setDefaultPermissionMode("acceptEdits"), setClaudeOwnSetup(true)]);
    expect(store.getState().settingsPrefs).toMatchObject({ claudeOwnSetup: true, defaultPermissionMode: "acceptEdits" });
  });

  it("leaves Use my Claude Code setup on when a notification switch is answered after it", async () => {
    const store = await generalLoaded();
    const { setClaudeOwnSetup, setNotificationCategoryEnabled } = store.getState();
    await Promise.all([setClaudeOwnSetup(true), setNotificationCategoryEnabled("session_done", false)]);
    expect(store.getState().settingsPrefs).toMatchObject({ claudeOwnSetup: true, disabledCategories: ["session_done"] });
  });
});
