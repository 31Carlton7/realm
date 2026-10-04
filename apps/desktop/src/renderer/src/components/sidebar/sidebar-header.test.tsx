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
  it("is the profile, then search and a new session — and nothing else", async () => {
    const { container } = await mount();
    const row = within(header(container));
    expect(row.getByRole("button", { name: "Profile: Work" })).toBeInTheDocument();
    expect(row.getByRole("button", { name: "Search" })).toBeInTheDocument();
    expect(row.getByRole("button", { name: "New session" })).toBeInTheDocument();
    expect(row.getAllByRole("button")).toHaveLength(3);
    // First in the column: it is the row in the traffic lights' band.
    expect(container.querySelector(".sidebar")!.firstElementChild).toBe(header(container));
    // No space title, flat space list or space menu any more: the spaces are the list's sections.
    expect(screen.queryByRole("button", { name: "Switch space" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Space menu" })).toBeNull();
    expect(screen.queryByRole("heading", { name: /Versed/ })).toBeNull();
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
    expect(button).toHaveAttribute("title", "New Claude session (⌘N)");
    await act(() => store.getState().newSession({ agentKind: "codex" }));
    expect(button).toHaveAttribute("title", "New Codex session (⌘N)");
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

describe("the profile switcher", () => {
  /** Work: Versed and Homework; School: Lectures, with a question waiting; Empty: no spaces. */
  const data = (): FakeData => ({
    profiles: [profile("p1", "Work", { color: "#ff0000" }), profile("p2", "School"), profile("p3", "Empty")],
    spaces: [space("s1", "p1", "Versed"), space("s2", "p1", "Homework"), space("s3", "p2", "Lectures")],
    sessions: [session("q", "s3", { status: "waiting_permission" }), session("w", "s1", { status: "waiting_permission" })],
  });
  const switcher = () => within(document.querySelector<HTMLElement>(".sb-header")!).getByRole("button", { name: /^Profile:/ });
  const open = async () => {
    fireEvent.click(switcher());
    return within(await screen.findByRole("menu", { name: "Profiles" }));
  };

  it("names the active profile in its own colour", async () => {
    const { container } = await mount(data());
    const button = switcher();
    expect(button).toHaveAccessibleName("Profile: Work");
    expect(button).toHaveTextContent("Work");
    expect(container.querySelector<HTMLElement>(".sb-header .sb-profile-mark")!.style.color).toBe("rgb(255, 0, 0)");
  });

  it("lists every profile, checks the one on screen, and says what waits in the others", async () => {
    // THE MUTANT: count the active profile's waiting too, or not at all — a question in School would
    // then wait unseen behind the switcher.
    await mount(data());
    const menu = await open();
    expect(menu.getByRole("menuitemcheckbox", { name: "Work" })).toHaveAttribute("aria-checked", "true");
    expect(menu.getByRole("menuitemcheckbox", { name: "School · 1 needs you" })).toHaveAttribute("aria-checked", "false");
  });

  it("lists a profile with no spaces without letting it be picked", async () => {
    await mount(data());
    const menu = await open();
    expect(menu.getByRole("menuitemcheckbox", { name: "Empty (no spaces)" })).toBeDisabled();
  });

  it("switches profile on select, landing in one of its spaces", async () => {
    const { store } = await mount(data());
    fireEvent.click((await open()).getByRole("menuitemcheckbox", { name: /School/ }));
    await waitFor(() => expect(store.getState().activeSpaceId).toBe("s3"));
    await waitFor(() => expect(switcher()).toHaveAccessibleName("Profile: School"));
  });

  it("opens the profile's page, New profile and every space from its foot", async () => {
    const { store } = await mount(data());
    fireEvent.click((await open()).getByRole("menuitem", { name: "Profile settings…" }));
    await waitFor(() => expect(store.getState().pageOverlay?.kind).toBe("profile-page"));
    await exited();
    fireEvent.click((await open()).getByRole("menuitem", { name: "New profile…" }));
    await waitFor(() => expect(store.getState().sheet).toEqual({ kind: "new-space" }));
    await exited();
    fireEvent.click((await open()).getByRole("menuitem", { name: /All spaces/ }));
    await waitFor(() => expect(store.getState().spacesOpen).toBe(true));
  });

  it("renders its menu in a portal, out of reach of the column's overflow", async () => {
    await mount(data());
    const menu = (await open()).getByRole("menuitemcheckbox", { name: "Work" }).closest(".menu") as HTMLElement;
    expect(menu.parentElement).toBe(document.body);
    expect(menu.style.position).toBe("fixed");
  });

  it("carries no theme items: appearance is Settings' business", async () => {
    await mount(data());
    const menu = await open();
    expect(menu.queryByRole("menuitemcheckbox", { name: /Theme|Palette/ })).toBeNull();
  });
});

describe("the lens", () => {
  it("reads Spaces until Recent is picked, and remembers the pick", async () => {
    const { api, store, container } = await mount({
      sessions: [session("se1", "s1", { title: "Fix the login form", updatedAt: Date.now() })],
      items: { s1: [item("i-se1", "s1", { kind: "session", refId: "se1", title: "Fix the login form" })] },
    });
    const lens = within(screen.getByRole("group", { name: "List" }));
    expect(lens.getByRole("radio", { name: "Spaces" })).toBeChecked();
    fireEvent.click(lens.getByRole("radio", { name: "Recent" }));
    await waitFor(() => expect(store.getState().sidebarLens).toBe("recent"));
    expect(api.calls).toContain("setSetting:ui.sidebarLens=recent");
    await waitFor(() => expect(container.querySelector(".sb-recent")).toHaveTextContent("Fix the login form"));
    expect(container.querySelector(".sb-sections")).toBeNull();
    expect(store.getState().sheet).toBeNull(); // a lens, not a sheet over the work
  });

  it("comes back on the lens it was left on", async () => {
    const { store } = await mount({ settings: { "ui.sidebarLens": "recent" } });
    await waitFor(() => expect(store.getState().sidebarLens).toBe("recent"));
    expect(within(screen.getByRole("group", { name: "List" })).getByRole("radio", { name: "Recent" })).toBeChecked();
  });
});
