import { describe, expect, it } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { AppShell } from "../../App";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi } from "../../state/store.test-fakes";

/** The shell, not the Sidebar alone: the whole point of this control is that it survives its own
 *  container being unmounted, which only the app shell can show. */
async function mountShell(api = fakeApi()) {
  const store = createAppStore(api);
  await store.getState().boot();
  const r = render(<StoreContext.Provider value={store}><AppShell /></StoreContext.Provider>);
  return { store, api, ...r };
}

const toggle = () => screen.getByRole("button", { name: /(Hide|Show) sidebar/ });

describe("sidebar collapse toggle", () => {
  it("collapses the sidebar and keeps a toggle on screen to bring it back", async () => {
    const { store } = await mountShell();
    // Open: the sidebar is mounted and the button offers to hide it.
    expect(document.querySelector(".sidebar")).not.toBeNull();
    expect(toggle()).toHaveAccessibleName("Hide sidebar (⌘B)");
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    // Kills a mutation that renders the toggle only in the open branch: after collapsing, the
    // sidebar is out of reach but exactly one toggle must remain, now offering the way back.
    fireEvent.click(toggle());
    await waitFor(() => expect(store.getState().sidebarCollapsed).toBe(true));
    /* The sidebar is still in the tree — it has to be, or there is nothing left to animate out —
       and `inert` is what makes that safe: no focus, no pointer, nothing in the a11y tree. Asserted
       as the two together, because a slide-away sidebar that is still tabbable is worse than one
       that blinks out. */
    const aside = document.querySelector(".sidebar");
    expect(aside).toHaveAttribute("data-collapsed");
    expect(aside).toHaveAttribute("inert");
    expect(screen.getAllByRole("button", { name: /(Hide|Show) sidebar/ })).toHaveLength(1);
    expect(toggle()).toHaveAccessibleName("Show sidebar (⌘B)");
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    // And back — the collapsed toggle is not decorative.
    fireEvent.click(toggle());
    await waitFor(() => expect(store.getState().sidebarCollapsed).toBe(false));
    expect(document.querySelector(".sidebar")).not.toHaveAttribute("inert");
  });

  it("lives in the rail, which collapsing leaves on screen, so it never moves", async () => {
    /* Plan 27: the rail is the window's left edge in both states. The toggle used to hop from the
       sidebar's head row to a corner overlay over the first pane bar; it sits in the rail now, the same
       button in the same place either way. Kills a mutation that parents it to the sidebar subtree
       (where collapsing would take it out of reach with the column). */
    const { store } = await mountShell();
    const rail = document.querySelector(".app-rail");
    expect(toggle().closest(".app-rail")).toBe(rail);
    expect(toggle().closest(".sidebar")).toBeNull();
    await act(async () => { await store.getState().toggleSidebar(); });
    expect(document.querySelector(".app")).toHaveAttribute("data-sidebar-collapsed");
    expect(toggle().closest(".app-rail")).toBe(rail);
    // The rail is before the sidebar, at the window's edge, and there is no corner overlay any more.
    expect(rail!.nextElementSibling).toHaveClass("sidebar");
    expect(document.querySelector(".sb-corner")).toBeNull();
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
