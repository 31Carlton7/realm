import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SpacePage } from "../panes/space/SpacePage";
import { StoreContext, createAppStore } from "../state/store";
import { fakeApi, item } from "../state/store.test-fakes";

describe("an icon being generated", () => {
  it("waits as a tile where it will land, turning the transcript's calm ring rather than the dotted orb", async () => {
    // The owner: "change image generation loader from that square with dots to something cleaner".
    // THE MUTANT: the orb spinner back in the Generate button, with nothing where the icon lands.
    const api = fakeApi();
    api.delays.generateIconAsset = 150;
    const store = createAppStore(api); await store.getState().boot();
    render(<StoreContext.Provider value={store}><SpacePage item={item("pg-s1", "s1", { kind: "space-page", title: "Overview", refId: "s1" })} visible /></StoreContext.Provider>);
    fireEvent.click(screen.getByRole("button", { name: "Change icon…" }));
    fireEvent.click(screen.getByRole("tab", { name: "Generated" }));
    fireEvent.change(screen.getByPlaceholderText(/Describe the icon you want/), { target: { value: "a friendly orange fox" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));

    const pending = await screen.findByRole("img", { name: "Generating an icon" });
    expect(pending.querySelectorAll(".gen-spin")).toHaveLength(1);
    expect(screen.getByRole("dialog", { name: "Choose an icon" }).querySelector(".spinner")).toBeNull();
    expect(screen.getByRole("button", { name: "Generating…" })).toHaveAttribute("aria-busy", "true");

    // Landed, the tile is the icon itself.
    await waitFor(() => expect(screen.queryByRole("img", { name: "Generating an icon" })).toBeNull());
    expect(api.calls).toContain("generateIconAsset:p1:a friendly orange fox");
  });
});
