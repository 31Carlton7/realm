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
    expect(document.querySelector(".sb-corner")).toBeNull();
    expect(toggle()).toHaveAccessibleName("Hide sidebar (⌘B)");
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    // Kills a mutation that renders the toggle only in the open branch: after collapsing, the
    // sidebar is gone but exactly one toggle must remain, now offering the way back.
    fireEvent.click(toggle());
    await waitFor(() => expect(store.getState().sidebarCollapsed).toBe(true));
    expect(document.querySelector(".sidebar")).toBeNull();
    expect(document.querySelector(".sb-corner")).not.toBeNull();
    expect(screen.getAllByRole("button", { name: /(Hide|Show) sidebar/ })).toHaveLength(1);
    expect(toggle()).toHaveAccessibleName("Show sidebar (⌘B)");
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    // And back — the collapsed toggle is not decorative.
    fireEvent.click(toggle());
    await waitFor(() => expect(store.getState().sidebarCollapsed).toBe(false));
    expect(document.querySelector(".sidebar")).not.toBeNull();
  });

  it("moves the toggle from the sidebar's head row into the window's corner", async () => {
    const { store } = await mountShell();
    // Open: inside the sidebar, in its head row (the traffic-light band), NOT in the corner.
    expect(toggle().closest(".sb-head")).not.toBeNull();
    expect(toggle().closest(".sidebar")).not.toBeNull();
    await act(async () => { await store.getState().toggleSidebar(); });
    // Collapsed: same button, now in the corner overlay. Kills a mutation that leaves it parented to
    // the sidebar subtree (where it would be unmounted with it) or drops the corner wrapper.
    const corner = toggle().closest(".sb-corner");
    expect(corner).not.toBeNull();
    expect(toggle().closest(".sb-head")).toBeNull();
    // After .main, not before it: panes are positioned, so a corner earlier in the DOM would be
    // painted over by the first pane's bar however the z-index reads.
    expect(corner!.previousElementSibling).toHaveClass("main");
    // …and no rail: the whole point is that collapsing costs no height any more. Whether the lights
    // actually clear the bar underneath is measured in sidebar-collapsed-live.mjs.
    expect(document.querySelector(".sb-rail")).toBeNull();
    expect(document.querySelector(".app")).toHaveAttribute("data-sidebar-collapsed");
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
