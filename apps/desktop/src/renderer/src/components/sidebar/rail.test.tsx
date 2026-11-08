import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DEFAULT_KEYBINDINGS, PAGE_REF_IDS, allItems, emptyLayout, itemIdOfLeaf } from "@realm/contracts";
import { AppShell } from "../../App";
import { Rail } from "./Rail";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, profile, session, space, type FakeData } from "../../state/store.test-fakes";
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
    const you = () => within(rail()).getByRole("button", { name: /^Carlton/ });
    expect(you().closest(".rail-foot")).not.toBeNull();
    fireEvent.click(you());
    fireEvent.click(within(await screen.findByRole("menu", { name: "Profiles" })).getByRole("menuitem", { name: "Carlton" }));
    await waitFor(() => expect(store.getState().pageOverlay?.kind).toBe("you-page"));
    await exited();
    fireEvent.click(you());
    fireEvent.click(within(await screen.findByRole("menu", { name: "Profiles" })).getByRole("menuitem", { name: /Settings/ }));
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

  it("says quietly while Laya installs itself, round its glyph once the download has a size, and opens Settings on a click", async () => {
    const base = { mode: "shadow" as const, installed: false, stepsLogged: 0, dir: "/Users/u/Realm/laya", assist: { available: false, reason: "x", threshold: null, accuracy: null } };
    const { store } = await mount();
    expect(within(rail()).queryByRole("button", { name: /^Installing Laya/ })).toBeNull();
    // The install's broadcast is what brings it: Settings need never have been opened.
    act(() => store.getState().applyLaya({ ...base, runtime: { state: "installing", step: "packages", detail: "Resolving laya 0.3.21 and PyTorch", fraction: null } }));
    // THE MUTANT: no rail mark — a couple of gigabytes downloading with nothing on screen saying so.
    const mark = within(rail()).getByRole("button", { name: "Installing Laya: Resolving laya 0.3.21 and PyTorch" });
    expect(mark).not.toHaveAttribute("data-measured");
    act(() => store.getState().applyLaya({ ...base, runtime: { state: "installing", step: "model", detail: "Downloading the checkpoint", fraction: 0.42 } }));
    const measured = within(rail()).getByRole("button", { name: "Installing Laya: checkpoint 42% downloaded" });
    expect(measured).toHaveAttribute("data-measured");
    expect(measured.style.getPropertyValue("--update-progress")).toBe("42%");
    fireEvent.click(measured);
    await waitFor(() => expect(store.getState().pageOverlay?.kind).toBe("settings-page"));
    act(() => store.getState().applyLaya({ ...base, installed: true, runtime: { state: "starting" } }));
    expect(within(rail()).queryByRole("button", { name: /^Installing Laya/ })).toBeNull();
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

describe("the profile's spaces on the rail", () => {
  /** Work holds Versed and Homework, Homework with a question waiting; School holds Lectures. */
  const work = (): FakeData => ({
    profiles: [profile("p1", "Work"), profile("p2", "School")],
    spaces: [space("s1", "p1", "Versed", { color: "#7c6cff" }), space("s2", "p1", "Homework"), space("s3", "p2", "Lectures")],
    items: { s1: [item("i-a", "s1", { kind: "session", refId: "a", title: "Alpha" })], s2: [item("i-b", "s2", { kind: "session", refId: "b", title: "Wants a yes" })] },
    sessions: [session("a", "s1", { title: "Alpha" }), session("b", "s2", { title: "Wants a yes", status: "waiting_permission" }),
      session("c", "s3", { title: "Notes" })],
  });
  const spaces = () => within(rail()).getByRole("group", { name: "Spaces" });
  const tiles = () => within(spaces()).getAllByRole("button").map((b) => b.getAttribute("aria-label"));

  it("lists only the profile on screen's spaces, then New space, under the destinations", async () => {
    // THE MUTANTS: every profile's spaces on the rail; the tiles above the destinations.
    const { store } = await mount(work());
    expect(tiles()).toEqual(["Versed", "Homework, 1 needs you", "New space"]);
    expect(spaces().previousElementSibling).toHaveClass("rail-group");
    await act(async () => { await store.getState().selectProfile("p2"); });
    await waitFor(() => expect(tiles()).toEqual(["Lectures", "New space"]));
  });

  it("lights the space the column shows, and a click makes another current", async () => {
    const { store } = await mount(work());
    const tile = (name: RegExp) => within(spaces()).getByRole("button", { name });
    expect(tile(/^Versed/)).toHaveAttribute("aria-pressed", "true");
    expect(tile(/^Homework/)).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(tile(/^Homework/));
    await waitFor(() => expect(store.getState().activeSpaceId).toBe("s2"));
    expect(tile(/^Homework/)).toHaveAttribute("aria-pressed", "true");
    expect(tile(/^Versed/)).toHaveAttribute("aria-pressed", "false");
  });

  it("wears the count of what waits on you in that space, and nothing for a space with none", async () => {
    // THE MUTANTS: a count of every session; a badge for a space where nothing waits.
    const { store } = await mount(work());
    const badge = (name: RegExp) => within(spaces()).getByRole("button", { name }).querySelector(".sb-badge");
    expect(badge(/^Homework/)).toHaveTextContent("1");
    expect(badge(/^Versed/)).toBeNull();
    act(() => store.getState().applySessionStatus("a", "running"));
    expect(badge(/^Versed/)).toBeNull();
    act(() => store.getState().applySessionStatus("a", "waiting_permission"));
    expect(badge(/^Versed/)).toHaveTextContent("1");
    // A failed turn you have not read is in Needs you, so it is in the count too.
    act(() => store.setState({ allSessions: { ...store.getState().allSessions, a: { ...store.getState().allSessions.a!, seenSeq: 1, lastEventSeq: 4 } } }));
    act(() => store.getState().applySessionStatus("a", "error"));
    expect(badge(/^Versed/)).toHaveTextContent("1");
  });

  it("opens New space from its + tile", async () => {
    const { store } = await mount(work());
    fireEvent.click(within(spaces()).getByRole("button", { name: "New space" }));
    await waitFor(() => expect(store.getState().sheet).toEqual({ kind: "new-space" }));
  });

  it("offers the space's settings, Rename and Delete on a right-click of its tile", async () => {
    const { store } = await mount(work());
    fireEvent.contextMenu(within(spaces()).getByRole("button", { name: /^Homework/ }), { clientX: 20, clientY: 200 });
    const menu = within(await screen.findByRole("menu", { name: "Homework" }));
    for (const name of ["Space settings", "Rename…", "Delete space…", "New session", "Add a teammate…"]) expect(menu.getByRole("menuitem", { name })).toBeInTheDocument();
    fireEvent.click(menu.getByRole("menuitem", { name: "Space settings" }));
    await waitFor(() => expect(store.getState().pageOverlay).toMatchObject({ kind: "space-page", refId: "s2" }));
    expect(store.getState().spacePageTab.s2).toBe("general");
    await exited();
    fireEvent.contextMenu(within(spaces()).getByRole("button", { name: /^Homework/ }), { clientX: 20, clientY: 200 });
    fireEvent.click(within(await screen.findByRole("menu", { name: "Homework" })).getByRole("menuitem", { name: "Rename…" }));
    await waitFor(() => expect(store.getState().renamingSpaceId).toBe("s2"));
    expect(store.getState().activeSpaceId).toBe("s2");
  });

  it("opens a space in a window of its own from its tile's right-click", async () => {
    // THE MUTANT: the item gone from the space menu, which is how #272 lost the way to a second window.
    const { api } = await mount(work());
    fireEvent.contextMenu(within(spaces()).getByRole("button", { name: /^Homework/ }), { clientX: 20, clientY: 200 });
    fireEvent.click(within(await screen.findByRole("menu", { name: "Homework" })).getByRole("menuitem", { name: "Open in new window" }));
    await waitFor(() => expect(api.calls).toContain("openSpaceWindow:s2"));
  });

  it("brings forward the window showing a space rather than showing it here too", async () => {
    // THE MUTANT: no ask before the switch, so one space's panes are in two windows at once.
    const { api, store } = await mount({ ...work(), spacesInOtherWindows: ["s2"] });
    fireEvent.click(within(spaces()).getByRole("button", { name: /^Homework/ }));
    await waitFor(() => expect(api.calls).toContain("focusSpaceWindow:s2"));
    expect(store.getState().activeSpaceId).toBe("s1");
    expect(within(spaces()).getByRole("button", { name: /^Versed/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("reorders within the profile by dragging one tile onto another, and not while sorted by activity", async () => {
    const { api, store } = await mount(work());
    const tile = (name: RegExp) => within(spaces()).getByRole("button", { name });
    const data: Record<string, string> = {};
    const dt = { setData: (k: string, v: string) => { data[k] = v; }, get types() { return Object.keys(data); }, effectAllowed: "" };
    fireEvent.dragStart(tile(/^Homework/), { dataTransfer: dt });
    fireEvent.dragOver(tile(/^Versed/), { dataTransfer: dt });
    fireEvent.drop(tile(/^Versed/), { dataTransfer: dt });
    await waitFor(() => expect(api.calls.some((c) => c.startsWith("reorderSpaces:"))).toBe(true));
    expect(api.calls.find((c) => c.startsWith("reorderSpaces:"))).toBe("reorderSpaces:s2,s1,s3");
    await act(async () => { await store.getState().setSidebarActivityOrder(true); });
    expect(tile(/^Versed/)).toHaveAttribute("draggable", "false");
  });
});

describe("the profile, at the rail's foot", () => {
  /** Work: Versed and Homework; School: Lectures, with a question waiting; Empty: no spaces. */
  const data = (): FakeData => ({
    profiles: [profile("p1", "Work", { color: "#ff0000" }), profile("p2", "School"), profile("p3", "Empty")],
    spaces: [space("s1", "p1", "Versed"), space("s2", "p1", "Homework"), space("s3", "p2", "Lectures")],
    sessions: [session("q", "s3", { status: "waiting_permission" }), session("w", "s1", { status: "waiting_permission" })],
  });
  const avatar = () => within(rail()).getByRole("button", { name: /^Carlton/ });
  const open = async () => {
    fireEvent.click(avatar());
    return within(await screen.findByRole("menu", { name: "Profiles" }));
  };

  it("lists every profile with its mark, checks the one on screen, and says what waits in the others", async () => {
    // THE MUTANT: count the active profile's waiting too, or not at all — a question in School would
    // then wait unseen behind the avatar.
    await mount(data());
    const menu = await open();
    expect(menu.getByRole("menuitemcheckbox", { name: "Work" })).toHaveAttribute("aria-checked", "true");
    expect(menu.getByRole("menuitemcheckbox", { name: "School · 1 needs you" })).toHaveAttribute("aria-checked", "false");
    expect(menu.getByRole("menuitemcheckbox", { name: "Empty (no spaces)" })).toBeDisabled();
    expect((menu.getByRole("menuitemcheckbox", { name: "Work" }).querySelector(".sb-profile-mark") as HTMLElement).style.color).toBe("rgb(255, 0, 0)");
  });

  it("wears the amber dot while another profile has something waiting, and not for the one on screen", async () => {
    // THE MUTANTS: no dot at all; a dot for the question in the profile already on screen.
    const { store } = await mount(data());
    expect(avatar().querySelector(".rail-you-dot")).not.toBeNull();
    expect(avatar()).toHaveAccessibleName(/1 waiting in another profile/);
    act(() => store.getState().applySessionStatus("q", "idle"));
    expect(avatar().querySelector(".rail-you-dot")).toBeNull();
  });

  it("switches profile on select, and the rail's spaces follow", async () => {
    const { store } = await mount(data());
    fireEvent.click((await open()).getByRole("menuitemcheckbox", { name: /School/ }));
    await waitFor(() => expect(store.getState().activeSpaceId).toBe("s3"));
    expect(within(within(rail()).getByRole("group", { name: "Spaces" })).getByRole("button", { name: /^Lectures/ })).toBeInTheDocument();
  });

  it("opens New profile and the profile's own settings", async () => {
    const { store } = await mount(data());
    fireEvent.click((await open()).getByRole("menuitem", { name: "New profile…" }));
    await waitFor(() => expect(store.getState().sheet).toEqual({ kind: "new-profile" }));
    await exited();
    act(() => store.getState().closeSheet());
    fireEvent.click((await open()).getByRole("menuitem", { name: "Profile settings…" }));
    await waitFor(() => expect(store.getState().pageOverlay?.kind).toBe("profile-page"));
  });
});
