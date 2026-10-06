import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DEFAULT_KEYBINDINGS, PAGE_REF_IDS, allItems, emptyLayout, itemIdOfLeaf } from "@realm/contracts";
import { AppShell } from "../../App";
import { Rail } from "./Rail";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, session, type FakeData } from "../../state/store.test-fakes";
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
const lead = () => document.querySelector<HTMLElement>(".window-lead")!;

describe("the rail", () => {
  it("holds the app's destinations as icon buttons, each with a name and a tooltip", async () => {
    await mount();
    for (const name of ["Home", "Library", "Connections", "Scheduled tasks", "Code review"]) {
      const button = within(rail()).getByRole("button", { name });
      expect(button).toHaveAttribute("title");
      expect(button.textContent).toBe(""); // icon only: the name is the accessible name, not a label
    }
  });

  it("opens each page over the workspace, lit while it is up, and puts it away on a second press", async () => {
    const { store, api } = await mount();
    const library = () => within(rail()).getByRole("button", { name: "Library" });
    fireEvent.click(library());
    await waitFor(() => expect(store.getState().pageOverlay?.kind).toBe("library-page"));
    expect(store.getState().pageOverlay).toMatchObject({ refId: PAGE_REF_IDS["library-page"] });
    expect(library()).toHaveAttribute("aria-pressed", "true");
    expect(api.calls.some((c) => c.startsWith("createItem:"))).toBe(false);
    fireEvent.click(library());
    await waitFor(() => expect(store.getState().pageOverlay).toBeNull());
    fireEvent.click(within(rail()).getByRole("button", { name: "Scheduled tasks" }));
    await waitFor(() => expect(store.getState().pageOverlay?.kind).toBe("schedules-page"));
  });

  it("opens Code review where Notifications was, as its own page", async () => {
    const { store } = await mount();
    fireEvent.click(within(rail()).getByRole("button", { name: "Code review" }));
    await waitFor(() => expect(store.getState().pageOverlay).toMatchObject({ kind: "code-review-page", refId: PAGE_REF_IDS["code-review-page"] }));
    expect(within(rail()).queryByRole("button", { name: /notifications/i })).toBeNull();
  });

  describe("Home", () => {
    const home = () => within(rail()).getByRole("button", { name: "Home" });
    const inFront = (store: Awaited<ReturnType<typeof mount>>["store"]) =>
      itemIdOfLeaf(store.getState().layout, store.getState().focusedLeafId);
    /** Mid-work: a session of Versed's in front. */
    const working = async () => {
      const mounted = await mount({
        items: { s1: [item("i-lead", "s1", { kind: "session", refId: "lead", title: "Lead" })] },
        sessions: [session("lead", "s1", { title: "Lead" })],
      });
      await act(async () => { await mounted.store.getState().openItem("i-lead"); });
      return mounted;
    };

    it("goes back from every page to the session that was in front, in its space, making nothing", async () => {
      // THE MUTANTS: Home as a page of its own again, or a Home that starts a session with one in front.
      const { store, api } = await working();
      const pages = [
        () => store.getState().openDestinationPage("library-page"), () => store.getState().openDestinationPage("connections-page"),
        () => store.getState().openDestinationPage("schedules-page"), () => store.getState().openDestinationPage("code-review-page"),
        () => store.getState().openDestinationPage("settings-page"), () => store.getState().openDestinationPage("you-page"),
        // Another space's Overview makes that space the current one while it is up.
        () => store.getState().openSpacePage("s2"), () => store.getState().openProfilePage(),
      ];
      for (const open of pages) {
        act(() => open());
        expect(store.getState().pageOverlay).not.toBeNull();
        fireEvent.click(home());
        await waitFor(() => expect(store.getState().pageOverlay).toBeNull());
        expect(inFront(store)).toBe("i-lead");
        expect(store.getState().activeSpaceId).toBe("s1");
      }
      expect(api.calls.some((c) => c.startsWith("createSession:"))).toBe(false);
    });

    it("lands on a fresh prompter when nothing was in front", async () => {
      // THE MUTANT: put the page away and stop, onto a pane that says to open something.
      const { store, api } = await mount({ items: { s1: [] } });
      expect(allItems(store.getState().layout ?? emptyLayout())).toEqual([]);
      act(() => store.getState().openDestinationPage("settings-page"));
      fireEvent.click(home());
      await waitFor(() => expect(api.calls.filter((c) => c.startsWith("createSession:"))).toHaveLength(1));
      expect(store.getState().pageOverlay).toBeNull();
      expect(store.getState().items.find((i) => i.id === inFront(store))?.kind).toBe("session");
    });

    it("is never lit and carries no count — a session waiting on you says so on its own row", async () => {
      // THE MUTANT: Home's old count of every session waiting on you, back at its shoulder.
      await mount({ sessions: [session("a", "s1", { status: "waiting_permission" }), session("b", "s2", { status: "waiting_permission" })] });
      expect(home()).not.toHaveAttribute("aria-pressed");
      expect(home()).toHaveAttribute("title", "Back to your sessions");
      expect(home().querySelector(".sb-badge")).toBeNull();
    });
  });

  it("holds no back and forward of its own in either state — they are the window's, beside the lights", async () => {
    // THE MUTANT: the old pair under the traffic lights while the sidebar is folded, which moved the
    // destinations down a row every time it folded.
    for (const collapsed of [false, true]) {
      await mount({ settings: { "ui.sidebarCollapsed": collapsed } }, true);
      expect(within(rail()).queryByRole("button", { name: "Go back" })).toBeNull();
      expect(within(lead()).getByRole("button", { name: "Go back" })).toBeInTheDocument();
      cleanup();
    }
  });

  it("steps the window back and forward from the lead, greyed at either end of the trail", async () => {
    const { store } = await mount({ settings: { "ui.sidebarCollapsed": true } }, true);
    const back = () => within(lead()).getByRole("button", { name: "Go back" });
    const forward = () => within(lead()).getByRole("button", { name: "Go forward" });
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
    const { store } = await mount({ settings: { "ui.sidebarCollapsed": true } }, true);
    const rules = DEFAULT_KEYBINDINGS.map((r) => (r.command === "window.back" ? { ...r, key: "mod+[" } : r));
    act(() => store.getState().setKeybindings(rules));
    expect(within(lead()).getByRole("button", { name: "Go back" })).toHaveAttribute("title", "Go back (⌘[)");
    expect(within(lead()).getByRole("button", { name: "Go forward" })).toHaveAttribute("title", "Go forward (⌃⇧-)");
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

  it("shows no update control while main knows of no newer version", async () => {
    // THE MUTANT: a disc for any state but the three that name a version — a control for an update
    // that does not exist.
    for (const state of [{ kind: "disabled", reason: "unsigned" }, { kind: "idle" }, { kind: "checking" }, { kind: "up-to-date" }, { kind: "error", message: "ENOTFOUND github.com" }] as const) {
      const { store } = await mount({ updateStatus: { version: "1.0.0", state } });
      await waitFor(() => expect(store.getState().updateStatus?.state.kind).toBe(state.kind));
      expect(rail().querySelector(".rail-update"), state.kind).toBeNull();
      cleanup();
    }
  });

  it("offers an available update's download, naming the version, and shows it downloading once asked", async () => {
    /* `available` is a version main knows of and is not fetching — its background download failed.
       THE MUTANT: the old rail, which drew nothing until an update was already downloaded. */
    const { api } = await mount({ updateStatus: { version: "1.0.0", state: { kind: "available", version: "1.1.0" } } });
    const button = await within(rail()).findByRole("button", { name: "Download Realm v1.1.0" });
    expect(button.closest(".rail-foot")).not.toBeNull();
    expect(button).toHaveAttribute("title", "Realm v1.1.0 is available — download it");
    fireEvent.click(button);
    await waitFor(() => expect(api.calls).toContain("downloadUpdate"));
    expect(api.calls).not.toContain("installUpdate");
    expect(await within(rail()).findByRole("progressbar", { name: "Downloading Realm v1.1.0" })).toBeInTheDocument();
  });

  it("follows a download as main pushes it, then restarts into the finished update", async () => {
    const { api } = await mount({ updateStatus: { version: "1.0.0", state: { kind: "downloading", version: "1.1.0", percent: null } } });
    const bar = await within(rail()).findByRole("progressbar", { name: "Downloading Realm v1.1.0" });
    // Until main has said how far it is, the bar claims no figure.
    expect(bar).not.toHaveAttribute("aria-valuenow");
    // Nothing to press while it downloads: waiting is the whole of the state.
    expect(within(rail()).queryByRole("button", { name: /Realm v1\.1\.0/ })).toBeNull();
    // THE MUTANT: no subscription to main's push — the ring would sit still until the window next
    // came to the front.
    act(() => api.emitUpdateStatus({ version: "1.0.0", state: { kind: "downloading", version: "1.1.0", percent: 42.4 } }));
    await waitFor(() => expect(bar).toHaveAttribute("aria-valuenow", "42"));
    expect(bar).toHaveAttribute("title", "Downloading Realm v1.1.0 — 42%");
    expect(bar.style.getPropertyValue("--update-progress")).toBe("42%");
    act(() => api.emitUpdateStatus({ version: "1.0.0", state: { kind: "downloaded", version: "1.1.0" } }));
    const restart = await within(rail()).findByRole("button", { name: "Restart to update to Realm v1.1.0" });
    expect(within(rail()).queryByRole("progressbar")).toBeNull();
    fireEvent.click(restart);
    await waitFor(() => expect(api.calls).toContain("installUpdate"));
    expect(api.calls).not.toContain("downloadUpdate");
  });

  it("carries the Stop of a recording for Laya while one runs anywhere, and nothing otherwise", async () => {
    const recording = { id: "rec-1", simulatorId: "sim-2", device: "Test iPhone", apps: ["TikTok"], seen: ["TikTok"], screens: 3, startedAt: "2026-09-29T07:12:00.000Z", endedAt: null, lastError: null };
    const laya = { mode: "off" as const, installed: false, runtime: { state: "off" as const }, stepsLogged: 0, dir: "/Users/u/Realm/laya", assist: { available: false, reason: "x", threshold: null, accuracy: null }, recording };
    const { api, store } = await mount({ laya });
    // Nothing is known until the server has said: no recording, no control.
    expect(within(rail()).queryByRole("button", { name: /^Stop recording/ })).toBeNull();
    await act(async () => { await store.getState().loadLaya(); });
    // THE MUTANT: a rail that never shows it. A recording whose device is out of sight could then be
    // ended only by going to find it.
    const stop = within(rail()).getByRole("button", { name: "Stop recording TikTok for Laya" });
    expect(stop).toHaveAttribute("title", "Recording TikTok for Laya on Test iPhone: 3 screens kept. Click to stop.");
    fireEvent.click(stop);
    await waitFor(() => expect(api.calls).toContain("layaStopRecording"));
    await waitFor(() => expect(within(rail()).queryByRole("button", { name: /^Stop recording/ })).toBeNull());
  });

  it("stays on screen when the sidebar is collapsed, and the way back is beside the traffic lights", async () => {
    const { store } = await mount({ settings: { "ui.sidebarCollapsed": true } }, true);
    expect(store.getState().sidebarCollapsed).toBe(true);
    expect(document.getElementById("app-sidebar")).toHaveAttribute("inert");
    expect(rail().closest("[inert]")).toBeNull();
    expect(within(rail()).getByRole("button", { name: "Home" })).toBeInTheDocument();
    // The toggle left the rail's foot for the top row (the owner, 10-04).
    expect(within(rail()).queryByRole("button", { name: /sidebar/ })).toBeNull();
    expect(within(lead()).getByRole("button", { name: "Show sidebar (⌘B)" })).toBeInTheDocument();
  });
});
