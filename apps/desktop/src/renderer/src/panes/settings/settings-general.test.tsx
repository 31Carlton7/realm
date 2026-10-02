import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { FILES_OPEN_IN_KEY, PAGE_REF_IDS, POWER_PREVENT_SLEEP_KEY, TERMINALS_DOCK_KEY } from "@realm/contracts";
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
