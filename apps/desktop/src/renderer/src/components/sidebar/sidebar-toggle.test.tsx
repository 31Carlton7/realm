import { describe, expect, it } from "vitest";
import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react";
import { AppShell } from "../../App";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi } from "../../state/store.test-fakes";

/** The shell, not the Sidebar alone: the whole point of this control is that it survives its own
 *  container closing, which only the app shell can show. */
async function mountShell(api = fakeApi()) {
  const store = createAppStore(api);
  await store.getState().boot();
  const r = render(<StoreContext.Provider value={store}><AppShell /></StoreContext.Provider>);
  return { store, api, ...r };
}

const lead = () => document.querySelector<HTMLElement>(".window-lead")!;
const head = () => document.querySelector<HTMLElement>(".sb-header")!;
/** The toggle a person can reach: the head row's while the sidebar is there, the lead's once it is not. */
const reachable = () => (document.querySelector(".app[data-sidebar-collapsed]") ? within(lead()) : within(head()))
  .getByRole("button", { name: /(Hide|Show) sidebar/ });

describe("sidebar collapse toggle", () => {
  it("is in the sidebar's head row while there is a sidebar, and in the window's lead once it has folded", async () => {
    /* The owner, 10-04: the toggle goes in the top row with search and a new session, and — Codex's
       way — stays reachable beside the traffic lights, back and forward when the sidebar is away.
       THE MUTANTS: a lead with no toggle once folded (a collapse with no way back), or one beside the
       head row's while the sidebar is still there (two toggles at once). */
    const { store } = await mountShell();
    expect(within(head()).getByRole("button", { name: "Hide sidebar (⌘B)" })).toHaveAttribute("aria-expanded", "true");
    expect(within(lead()).queryByRole("button", { name: /sidebar/ })).toBeNull();
    fireEvent.click(reachable());
    await waitFor(() => expect(store.getState().sidebarCollapsed).toBe(true));
    /* The sidebar is still in the tree — it has to be, or there is nothing left to animate out —
       and `inert` is what makes that safe: no focus, no pointer, nothing in the a11y tree. Asserted
       as the two together, because a slide-away sidebar that is still tabbable is worse than one
       that blinks out. */
    const aside = document.querySelector(".sidebar");
    expect(aside).toHaveAttribute("data-collapsed");
    expect(aside).toHaveAttribute("inert");
    // jsdom runs no transition, so the column has folded at once and the lead holds the way back.
    expect(document.querySelector(".app")).toHaveAttribute("data-sidebar-folded");
    const back = within(lead()).getByRole("button", { name: "Show sidebar (⌘B)" });
    expect(back).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(back);
    await waitFor(() => expect(store.getState().sidebarCollapsed).toBe(false));
    expect(document.querySelector(".sidebar")).not.toHaveAttribute("inert");
    expect(document.querySelector(".app")).not.toHaveAttribute("data-sidebar-folded");
    expect(within(lead()).queryByRole("button", { name: /sidebar/ })).toBeNull();
  });

  it("wears the window-with-its-left-panel glyph, not the sidebar-with-rows one", async () => {
    // The owner asked for the layout-left mark by name: the old glyph drew list rows in the panel.
    await mountShell();
    const glyph = reachable().querySelector("svg")!;
    expect(glyph.querySelectorAll("path")).toHaveLength(2);
  });

  it("keeps the window's back and forward beside the traffic lights in both states, and nowhere else", async () => {
    // THE MUTANT: a pair in the sidebar's head row again, or in the rail — a second pair a few inches
    // from the first, or a pair that moves when the sidebar does.
    const { store } = await mountShell();
    for (const collapsed of [false, true]) {
      if (collapsed) await act(async () => { await store.getState().toggleSidebar(); });
      expect(within(lead()).getByRole("button", { name: "Go back" })).toBeInTheDocument();
      expect(within(lead()).getByRole("button", { name: "Go forward" })).toBeInTheDocument();
      expect(screen.getAllByRole("button", { name: "Go back" })).toHaveLength(1);
    }
    // After the panes in the document, which is what keeps it clickable over the bars' drag regions.
    expect(document.querySelector(".main")!.compareDocumentPosition(lead()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("persists the collapsed state so a collapsed window reopens collapsed", async () => {
    const { store, api } = await mountShell();
    await act(async () => { await store.getState().toggleSidebar(); });
    expect(api.calls).toContain("setSetting:ui.sidebarCollapsed=true");
    // A fresh store reading the same settings must boot collapsed — kills a mutation that writes the
    // setting but never reads it back at boot.
    const restored = createAppStore(fakeApi({ settings: { "ui.sidebarCollapsed": true } }));
    await restored.getState().boot();
    expect(restored.getState().sidebarCollapsed).toBe(true);
  });

  it("defaults to expanded when the persisted value is missing or malformed", async () => {
    // The settings file is user-editable, so a non-boolean must not collapse the sidebar by
    // truthiness — kills a `!!raw` mutation in place of the `=== true` check.
    for (const bad of [undefined, null, "yes", 1, {}]) {
      const store = createAppStore(fakeApi({ settings: { "ui.sidebarCollapsed": bad } }));
      await store.getState().boot();
      expect(store.getState().sidebarCollapsed, `for ${JSON.stringify(bad)}`).toBe(false);
    }
  });
});

describe("a page with no use for the spaces", () => {
  const shown = () => !document.querySelector(".app")!.hasAttribute("data-sidebar-collapsed");

  it("takes the sidebar away while it is up — Connections, Notifications, Scheduled — and gives it back as it was", async () => {
    /* The owner, 10-04: no sidebar on Connections or Notifications; and the Scheduled page draws its
       own column of tasks. The page takes the width right of the rail. THE MUTANTS: a page left out of
       the declaration, or the page writing the person's own collapse setting (so leaving it would not
       bring the sidebar back). */
    const { store, api } = await mountShell();
    for (const kind of ["connections-page", "notifications-page", "schedules-page"] as const) {
      act(() => store.getState().openDestinationPage(kind));
      await waitFor(() => expect(shown(), kind).toBe(false));
      expect(document.getElementById("app-sidebar")).toHaveAttribute("inert");
      expect(within(lead()).getByRole("button", { name: "Show sidebar (⌘B)" })).toBeInTheDocument();
      act(() => store.getState().closePageOverlay());
      await waitFor(() => expect(shown(), kind).toBe(true));
    }
    expect(store.getState().sidebarCollapsed).toBe(false);
    expect(api.calls.some((c) => c.startsWith("setSetting:ui.sidebarCollapsed"))).toBe(false);
  });

  it("leaves the sidebar alone on every other page", async () => {
    const { store } = await mountShell();
    for (const kind of ["agents-page", "library-page", "settings-page", "you-page"] as const) {
      act(() => store.getState().openDestinationPage(kind));
      await waitFor(() => expect(store.getState().pageOverlay?.kind).toBe(kind));
      expect(shown(), kind).toBe(true);
    }
  });

  it("brings back a sidebar the person had folded away as folded", async () => {
    const { store } = await mountShell(fakeApi({ settings: { "ui.sidebarCollapsed": true } }));
    act(() => store.getState().openDestinationPage("connections-page"));
    await waitFor(() => expect(store.getState().pageOverlay?.kind).toBe("connections-page"));
    act(() => store.getState().closePageOverlay());
    expect(shown()).toBe(false);
  });

  it("answers ⌘B with the sidebar for that visit alone, and persists nothing", async () => {
    // THE MUTANT: a ⌘B that does nothing on these pages, or one that flips the setting every other
    // screen reads.
    const { store, api } = await mountShell();
    act(() => store.getState().openDestinationPage("connections-page"));
    await waitFor(() => expect(shown()).toBe(false));
    fireEvent.click(within(lead()).getByRole("button", { name: "Show sidebar (⌘B)" }));
    await waitFor(() => expect(shown()).toBe(true));
    expect(within(head()).getByRole("button", { name: "Hide sidebar (⌘B)" })).toBeInTheDocument();
    expect(api.calls.some((c) => c.startsWith("setSetting:ui.sidebarCollapsed"))).toBe(false);
    // The visit ends with the page: the next time it opens, it opens without the sidebar again.
    act(() => store.getState().closePageOverlay());
    act(() => store.getState().openDestinationPage("connections-page"));
    await waitFor(() => expect(shown()).toBe(false));
  });
});
