import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DEFAULT_KEYBINDINGS, PAGE_REF_IDS } from "@realm/contracts";
import { AppShell } from "../../App";
import { Rail } from "./Rail";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, profile, session, space, type FakeData } from "../../state/store.test-fakes";
import { exited } from "../popover-exit.test-fakes";

async function mount(over: FakeData = {}, shell = false) {
  const api = fakeApi(over);
  const store = createAppStore(api);
  await store.getState().boot();
  const r = render(<StoreContext.Provider value={store}>{shell ? <AppShell /> : <Rail />}</StoreContext.Provider>);
  return { api, store, ...r };
}

afterEach(() => cleanup());

const rail = () => screen.getByRole("navigation", { name: "Destinations" });

describe("the rail", () => {
  it("holds the app's destinations as icon buttons, each with a name and a tooltip", async () => {
    await mount();
    for (const name of ["Home", "Library", "Connections", "Scheduled tasks", "Notifications"]) {
      const button = within(rail()).getByRole("button", { name });
      expect(button).toHaveAttribute("title");
      expect(button.textContent).toBe(""); // icon only: the name is the accessible name, not a label
    }
  });

  it("opens each page over the workspace, lit while it is up, and puts it away on a second press", async () => {
    const { store, api } = await mount();
    const home = () => within(rail()).getByRole("button", { name: "Home" });
    fireEvent.click(home());
    await waitFor(() => expect(store.getState().pageOverlay?.kind).toBe("agents-page"));
    expect(store.getState().pageOverlay).toMatchObject({ refId: PAGE_REF_IDS["agents-page"] });
    expect(home()).toHaveAttribute("aria-pressed", "true");
    expect(api.calls.some((c) => c.startsWith("createItem:"))).toBe(false);
    fireEvent.click(home());
    await waitFor(() => expect(store.getState().pageOverlay).toBeNull());
    fireEvent.click(within(rail()).getByRole("button", { name: "Scheduled tasks" }));
    await waitFor(() => expect(store.getState().pageOverlay?.kind).toBe("schedules-page"));
  });

  it("wears Home's count: every session waiting on you, in any space of any profile", async () => {
    const { store, container } = await mount({
      profiles: [profile("p1", "Work"), profile("p2", "School")],
      spaces: [space("s1", "p1", "Versed"), space("s2", "p2", "Lectures")],
      sessions: [session("a", "s1", { status: "waiting_permission" }), session("b", "s2", { status: "waiting_permission" }), session("c", "s1", { status: "running" })],
    });
    const home = within(rail()).getByRole("button", { name: "Home, 2 waiting on you" });
    expect(within(home).getByText("2")).toHaveClass("sb-badge");
    act(() => { store.getState().applySessionStatus("a", "running"); store.getState().applySessionStatus("b", "idle"); });
    await waitFor(() => expect(within(rail()).getByRole("button", { name: "Home" })).toBeInTheDocument());
    // Nothing waiting is no badge at all, not a zero.
    expect(container.querySelector(".sb-badge")).toBeNull();
  });

  it("carries the window's back and forward only while the sidebar is folded away", async () => {
    // Open, they are the sidebar's head row's (WindowNav): one pair in the window, not two.
    await mount();
    expect(within(rail()).queryByRole("button", { name: "Go back" })).toBeNull();
    cleanup();
    await mount({ settings: { "ui.sidebarCollapsed": true } });
    expect(within(rail()).getByRole("button", { name: "Go back" })).toBeInTheDocument();
  });

  it("steps the window back and forward, greyed at either end of the trail", async () => {
    const { store } = await mount({ settings: { "ui.sidebarCollapsed": true } });
    const back = () => within(rail()).getByRole("button", { name: "Go back" });
    const forward = () => within(rail()).getByRole("button", { name: "Go forward" });
    expect(back()).toBeDisabled();
    expect(forward()).toBeDisabled();
    await act(async () => { await store.getState().selectSpace("s2"); });
    await waitFor(() => expect(back()).toBeEnabled());
    fireEvent.click(back());
    await waitFor(() => expect(store.getState().activeSpaceId).toBe("s1"));
    await waitFor(() => expect(forward()).toBeEnabled());
    fireEvent.click(forward());
    await waitFor(() => expect(store.getState().activeSpaceId).toBe("s2"));
  });

  it("prints the person's own chord for back and forward, not the shipped one", async () => {
    const { store } = await mount({ settings: { "ui.sidebarCollapsed": true } });
    const rules = DEFAULT_KEYBINDINGS.map((r) => (r.command === "window.back" ? { ...r, key: "mod+[" } : r));
    act(() => store.getState().setKeybindings(rules));
    expect(within(rail()).getByRole("button", { name: "Go back" })).toHaveAttribute("title", "Go back (⌘[)");
    expect(within(rail()).getByRole("button", { name: "Go forward" })).toHaveAttribute("title", "Go forward (⌃⇧-)");
  });

  it("opens the page about you and Settings from the person at its foot", async () => {
    const { store } = await mount();
    const you = within(rail()).getByRole("button", { name: "Carlton" });
    expect(you.closest(".rail-foot")).not.toBeNull();
    fireEvent.click(you);
    fireEvent.click(within(await screen.findByRole("menu", { name: "You" })).getByRole("menuitem", { name: "Carlton" }));
    await waitFor(() => expect(store.getState().pageOverlay?.kind).toBe("you-page"));
    await exited();
    fireEvent.click(within(rail()).getByRole("button", { name: "Carlton" }));
    fireEvent.click(within(await screen.findByRole("menu", { name: "You" })).getByRole("menuitem", { name: /Settings/ }));
    await waitFor(() => expect(store.getState().pageOverlay?.kind).toBe("settings-page"));
  });

  it("shows the update control only once an update is downloaded, and it restarts into it", async () => {
    const first = await mount();
    // Asked for when the window is at the front — and only then is "nothing to show" an answer.
    await waitFor(() => expect(first.store.getState().updateStatus?.state.kind).toBe("disabled"));
    expect(within(rail()).queryByRole("button", { name: /Restart to update/ })).toBeNull();
    cleanup();
    const { api } = await mount({ updateStatus: { version: "1.0.0", state: { kind: "downloaded", version: "1.1.0" } } });
    const update = await within(rail()).findByRole("button", { name: "Restart to update to v1.1.0" });
    expect(update.closest(".rail-foot")).not.toBeNull();
    fireEvent.click(update);
    await waitFor(() => expect(api.calls).toContain("installUpdate"));
  });

  it("stays on screen when the sidebar is collapsed, with the way back in it", async () => {
    const { store } = await mount({ settings: { "ui.sidebarCollapsed": true } }, true);
    expect(store.getState().sidebarCollapsed).toBe(true);
    expect(document.getElementById("app-sidebar")).toHaveAttribute("inert");
    expect(rail().closest("[inert]")).toBeNull();
    expect(within(rail()).getByRole("button", { name: "Show sidebar (⌘B)" })).toBeInTheDocument();
    expect(within(rail()).getByRole("button", { name: "Home" })).toBeInTheDocument();
  });
});
