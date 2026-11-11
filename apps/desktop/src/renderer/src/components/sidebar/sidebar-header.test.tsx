import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DEFAULT_KEYBINDINGS } from "@realm/contracts";
import { Sidebar } from "./Sidebar";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, profile, session, space, type FakeData } from "../../state/store.test-fakes";
import { REALM_NEW_SESSION_TYPE } from "../drag-types";
import { exited } from "../popover-exit.test-fakes";

async function mount(over: FakeData = {}) {
  const api = fakeApi(over);
  const store = createAppStore(api);
  await store.getState().boot();
  const r = render(<StoreContext.Provider value={store}><Sidebar /></StoreContext.Provider>);
  return { api, store, ...r };
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const header = (container: HTMLElement) => container.querySelector<HTMLElement>(".sb-header")!;

describe("the sidebar's head row", () => {
  it("is the sidebar's toggle, search and a new session — and nothing else", async () => {
    /* The row's start is the window's now: the traffic lights cross into it over the narrower rail,
       and back and forward sit just past them in both states (WindowLead). THE MUTANTS: back and
       forward drawn here again (a second pair beside the window's), or the toggle left out of the row
       it was asked into (the owner, 10-04: "with the search button and create new session button"). */
    const { container } = await mount();
    const row = within(header(container));
    expect(row.getAllByRole("button").map((b) => b.getAttribute("aria-label")))
      .toEqual(["Hide sidebar (⌘B)", "Search", "New session"]);
    // First in the column's slide: it is the row in the traffic lights' band.
    expect(container.querySelector(".sidebar-slide")!.firstElementChild).toBe(header(container));
    // The space heads the column under it, outside the scroller, on its own row — a title, and no
    // switcher of spaces or profiles: those are the rail's.
    const title = container.querySelector<HTMLElement>(".sb-title")!;
    expect(within(title).getByRole("heading", { name: "Versed" })).toBeInTheDocument();
    expect(title.closest(".space-body")).toBeNull();
    expect(title.nextElementSibling).toHaveClass("space-body");
    expect(screen.queryByRole("button", { name: /^Profile:/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Switch space" })).toBeNull();
  });

  it("folded, keeps its controls out of the keyboard's reach under the traffic lights (TN-02)", async () => {
    const api = fakeApi({});
    const store = createAppStore(api);
    await store.getState().boot();
    const { container } = render(<StoreContext.Provider value={store}><Sidebar collapsed /></StoreContext.Provider>);
    for (const name of ["Search", "New session"])
      expect(within(header(container)).getByRole("button", { name, hidden: true }).closest("[inert]")).not.toBeNull();
  });

  it("opens the palette from search, printing the person's own chord", async () => {
    const { store, container } = await mount();
    const search = within(header(container)).getByRole("button", { name: "Search" });
    expect(search).toHaveAttribute("title", "Search (⌘K)");
    fireEvent.click(search);
    await waitFor(() => expect(store.getState().paletteOpen).toBe(true));
    act(() => store.getState().setKeybindings(DEFAULT_KEYBINDINGS.map((r) => (r.command === "palette.toggle" ? { ...r, key: "mod+shift+o" } : r))));
    expect(search).toHaveAttribute("title", "Search (⌘⇧O)");
  });

  it("makes a new session in the space on screen on the first click — no menu, no sheet", async () => {
    const { api, store, container } = await mount();
    const button = within(header(container)).getByRole("button", { name: "New session" });
    expect(button).not.toHaveAttribute("aria-haspopup");
    fireEvent.click(button);
    await waitFor(() => expect(api.calls).toContain("createSession:claude"));
    expect(store.getState().sheet).toBeNull();
    const made = api.data.sessions.at(-1)!;
    expect(made.spaceId).toBe("s1");
    expect(store.getState().items.some((i) => i.kind === "session" && i.refId === made.id)).toBe(true);
    // The tooltip names the agent you will get, and follows the last one used.
    expect(button).toHaveAttribute("title", "New session (⌘N)");
    await act(() => store.getState().newSession({ agentKind: "codex" }));
    expect(button).toHaveAttribute("title", "New session (⌘N)");
  });

  it("drags a new session onto a pane without making one until it is dropped", async () => {
    const { api, container } = await mount();
    const button = within(header(container)).getByRole("button", { name: "New session" });
    const types: Record<string, string> = {};
    const dataTransfer = { setData: (k: string, v: string) => { types[k] = v; }, effectAllowed: "" };
    fireEvent.dragStart(button, { dataTransfer });
    expect(types[REALM_NEW_SESSION_TYPE]).toBe("new-session");
    expect(button).toHaveAttribute("data-dragging");
    fireEvent.dragEnd(button);
    expect(button).not.toHaveAttribute("data-dragging");
    expect(api.calls).not.toContain("createSession:fake");
  });
});

describe("the list's head", () => {
  const head = () => document.querySelector<HTMLElement>(".sb-lens")!;
  const switcher = () => within(head()).getByRole("button", { name: "Activity" });

  it("heads the activity with a lit switch that goes back to the space, and the setting keeps the choice", async () => {
    // The owner, 10-04: an activity button shows the activity — exactly what Recent showed. It opens
    // from the space's Show all or the title's "···"; while it is up its head says so. THE MUTANTS: a
    // switch that does not say it is on, or a choice that is not remembered.
    const { api, store, container } = await mount({
      sessions: [session("se1", "s1", { title: "Fix the login form", updatedAt: Date.now() })],
      items: { s1: [item("i-se1", "s1", { kind: "session", refId: "se1", title: "Fix the login form" })] },
    });
    expect(screen.queryByRole("radio")).toBeNull();
    expect(container.querySelector(".sb-lens")).toBeNull();
    await act(async () => { await store.getState().setSidebarLens("recent"); });
    expect(api.calls).toContain("setSetting:ui.sidebarLens=recent");
    await waitFor(() => expect(container.querySelector(".sb-recent")).toHaveTextContent("Fix the login form"));
    expect(container.querySelector(".sb-section")).toBeNull();
    expect(head()).toHaveTextContent("Activity");
    expect(switcher()).toHaveAttribute("aria-pressed", "true");
    expect(switcher()).toHaveAttribute("title", "Back to the space");
    fireEvent.click(switcher());
    await waitFor(() => expect(store.getState().sidebarLens).toBe("spaces"));
    expect(container.querySelector(".sb-section")).not.toBeNull();
    expect(store.getState().sheet).toBeNull(); // a lens, not a sheet over the work
  });

  it("comes back on the reading it was left on", async () => {
    const { store } = await mount({ settings: { "ui.sidebarLens": "recent" } });
    await waitFor(() => expect(store.getState().sidebarLens).toBe("recent"));
    expect(head()).toHaveTextContent("Activity");
    expect(switcher()).toHaveAttribute("aria-pressed", "true");
  });
});
