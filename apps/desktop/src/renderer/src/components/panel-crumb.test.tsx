import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { spaceColor } from "@realm/ui";
import { Main } from "../App";
import { StoreContext, createAppStore } from "../state/store";
import { fakeApi, item, session, space } from "../state/store.test-fakes";

/**
 * A session's pane bar names the space it works in before its title — `Homework › Wants a yes` —
 * in the space's colour, the space's name opening its page (Plan 27). With spaces no longer rooms
 * you switch to, this is how the window keeps saying which space a session works in.
 */

async function mount() {
  const api = fakeApi({
    spaces: [space("s1", "p1", "Homework", { color: "#3ddc97" })],
    items: { s1: [item("i-s", "s1", { kind: "session", refId: "se1", title: "Wants a yes" }), item("i-a", "s1", { kind: "artifact", refId: "a1", title: "notes.md" })] },
    sessions: [session("se1", "s1", { title: "Wants a yes" })],
  });
  const store = createAppStore(api);
  await store.getState().boot();
  render(<StoreContext.Provider value={store}><Main /></StoreContext.Provider>);
  return { api, store };
}

const rgb = (hex: string) => { const n = Number.parseInt(hex.slice(1), 16); return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`; };

afterEach(() => cleanup());

describe("a session's breadcrumb", () => {
  it("reads Homework › title, the space in its colour, before the title", async () => {
    const { store } = await mount();
    await store.getState().openItem("i-s", store.getState().focusedLeafId);
    const crumb = await screen.findByRole("button", { name: "Open Homework" });
    const bar = crumb.closest(".panel-bar")!;
    expect(bar.textContent).toContain("Homework›Wants a yes");
    expect(crumb.nextElementSibling).toHaveTextContent("›");
    expect(crumb.nextElementSibling!.nextElementSibling).toHaveAccessibleName("Rename Wants a yes");
    // THE MUTANT: the space in the chrome's ink — the colour would mark nothing in the window.
    expect(crumb.querySelector<HTMLElement>(".panel-crumb-icon")!.style.color).toBe(rgb(spaceColor("#3ddc97", "light")));
    // The crumb stands where the kind's glyph stood; there is not a second icon beside it.
    expect(bar.querySelector(".panel-icon")).toBeNull();
  });

  it("opens the space's page from its name", async () => {
    const { store } = await mount();
    await store.getState().openItem("i-s", store.getState().focusedLeafId);
    fireEvent.click(await screen.findByRole("button", { name: "Open Homework" }));
    await waitFor(() => expect(store.getState().pageOverlay).toMatchObject({ kind: "space-page", refId: "s1" }));
  });

  it("is a session's alone: any other pane keeps its kind's glyph", async () => {
    const { store } = await mount();
    await store.getState().openItem("i-a", store.getState().focusedLeafId);
    const title = await screen.findByRole("button", { name: "Rename notes.md" });
    expect(screen.queryByRole("button", { name: "Open Homework" })).toBeNull();
    expect(title.closest(".panel-bar")!.querySelector(".panel-icon")).not.toBeNull();
  });
});
