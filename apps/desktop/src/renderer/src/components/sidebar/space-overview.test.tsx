import { describe, expect, it } from "vitest";
import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { SpaceOverview, useSpacesHotkey } from "./SpaceOverview";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, space } from "../../state/store.test-fakes";

/** Three spaces over two profiles: p1 Work (Versed, Homework), p2 School (Thesis). */
const threeSpaces = () => fakeApi({
  spaces: [space("s1", "p1", "Versed"), space("s2", "p1", "Homework"), space("s3", "p2", "Thesis")],
  items: { s1: [], s2: [], s3: [] },
});

async function mount(api = threeSpaces(), { open = true } = {}) {
  const store = createAppStore(api);
  await store.getState().boot();
  if (open) act(() => store.getState().setSpacesOpen(true));
  const r = render(<StoreContext.Provider value={store}><SpaceOverview /></StoreContext.Provider>);
  return { store, api, ...r };
}

const section = (name: string) => screen.getByRole("heading", { name: new RegExp(name) }).parentElement!;

describe("SpaceOverview", () => {
  it("renders nothing until it is opened", async () => {
    await mount(threeSpaces(), { open: false });
    expect(screen.queryByRole("dialog", { name: "All spaces" })).toBeNull();
  });

  it("lists every space in the home — across profiles, under its profile's heading, by NAME", async () => {
    await mount();
    // The whole point: the strip is scoped to one profile, so this is the surface that is not.
    expect(within(section("Work")).getByRole("button", { name: /switch to space Versed/i })).toBeInTheDocument();
    expect(within(section("Work")).getByRole("button", { name: /switch to space Homework/i })).toBeInTheDocument();
    expect(within(section("School")).getByRole("button", { name: /switch to space Thesis/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /switch to space Versed/i })).toHaveTextContent("Versed");
  });

  it("marks the current space and opens with the cursor on it, not on the first card", async () => {
    const { store } = await mount();
    await act(async () => { await store.getState().selectSpace("s3"); });
    const thesis = screen.getByRole("button", { name: /switch to space Thesis/i });
    expect(thesis).toHaveAttribute("data-current", "true");
    // Named mutant: initialising the cursor to 0, which would put Enter on Versed.
    expect(thesis).toHaveAttribute("data-cursor", "true");
    expect(screen.getByRole("button", { name: /switch to space Versed/i })).not.toHaveAttribute("data-cursor");
  });

  it("picking a space in ANOTHER profile switches to it and closes", async () => {
    const { store } = await mount();
    expect(store.getState().activeSpaceId).toBe("s1");
    fireEvent.click(screen.getByRole("button", { name: /switch to space Thesis/i }));
    await waitFor(() => expect(store.getState().activeSpaceId).toBe("s3"));
    expect(store.getState().spacesOpen).toBe(false);
    // Crossing profiles here is what makes the chip's "back to where I was" true afterwards.
    expect(store.getState().lastSpaceByProfile.p2).toBe("s3");
  });

  it("the filter narrows to matching spaces and drops a profile whose section would be empty", async () => {
    await mount();
    fireEvent.change(screen.getByRole("textbox", { name: "Filter spaces" }), { target: { value: "thes" } });
    expect(screen.getByRole("button", { name: /switch to space Thesis/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /switch to space Versed/i })).toBeNull();
    // An empty heading is worse than no heading — the section goes with its last space.
    expect(screen.queryByRole("heading", { name: /Work/ })).toBeNull();
    expect(screen.getByRole("heading", { name: /School/ })).toBeInTheDocument();
  });

  it("a profile name matches its spaces, so filtering by profile keeps that whole section", async () => {
    await mount();
    fireEvent.change(screen.getByRole("textbox", { name: "Filter spaces" }), { target: { value: "school" } });
    expect(screen.getByRole("button", { name: /switch to space Thesis/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /switch to space Homework/i })).toBeNull();
  });

  it("says so when nothing matches, rather than showing an empty grid", async () => {
    await mount();
    fireEvent.change(screen.getByRole("textbox", { name: "Filter spaces" }), { target: { value: "zzz" } });
    expect(screen.getByText(/No space matches/)).toBeInTheDocument();
  });

  it("→ steps one card, ↓ steps a whole ROW of three, and ↵ switches to whatever the cursor is on", async () => {
    // Five spaces, so a row step and a card step land somewhere different: from Versed, → is Homework
    // but ↓ is Deploys. With four or fewer they coincide and the stride is untestable.
    const { store } = await mount(fakeApi({
      spaces: [space("s1", "p1", "Versed"), space("s2", "p1", "Homework"), space("s4", "p1", "Notes"),
               space("s5", "p1", "Deploys"), space("s3", "p2", "Thesis")],
      items: { s1: [], s2: [], s3: [], s4: [], s5: [] },
    }));
    const dialog = screen.getByRole("dialog", { name: "All spaces" });
    const cursorOn = () => screen.getAllByRole("button").find((b) => b.hasAttribute("data-cursor"))!;
    expect(cursorOn()).toHaveTextContent("Versed"); // s1 is active
    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    expect(cursorOn()).toHaveTextContent("Homework");
    fireEvent.keyDown(dialog, { key: "ArrowLeft" });
    expect(cursorOn()).toHaveTextContent("Versed");
    // Three columns: index 0 + 3 = "Deploys". A stride of one would say "Homework".
    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    expect(cursorOn()).toHaveTextContent("Deploys");
    // The walk crosses the profile heading — the cursor follows reading order, not sections.
    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    expect(cursorOn()).toHaveTextContent("Thesis");
    fireEvent.keyDown(dialog, { key: "Enter" });
    await waitFor(() => expect(store.getState().activeSpaceId).toBe("s3"));
  });

  it("↓ clamps at the last card instead of running off the end", async () => {
    await mount();
    const dialog = screen.getByRole("dialog", { name: "All spaces" });
    const cursorOn = () => screen.getAllByRole("button").find((b) => b.hasAttribute("data-cursor"))!;
    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    expect(cursorOn()).toHaveTextContent("Thesis");
  });

  it("↑/← clamp at the first card instead of wrapping round to the last", async () => {
    await mount();
    const dialog = screen.getByRole("dialog", { name: "All spaces" });
    const cursorOn = () => screen.getAllByRole("button").find((b) => b.hasAttribute("data-cursor"))!;
    fireEvent.keyDown(dialog, { key: "ArrowLeft" });
    fireEvent.keyDown(dialog, { key: "ArrowUp" });
    expect(cursorOn()).toHaveTextContent("Versed");
  });

  it("Escape and a click on the scrim both close it; a click inside does not", async () => {
    const { store, container } = await mount();
    fireEvent.mouseDown(screen.getByRole("dialog", { name: "All spaces" }));
    expect(store.getState().spacesOpen).toBe(true);
    fireEvent.mouseDown(container.querySelector(".spaces-backdrop")!);
    expect(store.getState().spacesOpen).toBe(false);

    act(() => store.getState().setSpacesOpen(true));
    fireEvent.keyDown(screen.getByRole("dialog", { name: "All spaces" }), { key: "Escape" });
    expect(store.getState().spacesOpen).toBe(false);
  });
});

describe("useSpacesHotkey (⌘⇧Space)", () => {
  async function hotkeys() {
    const store = createAppStore(threeSpaces());
    await store.getState().boot();
    renderHook(() => useSpacesHotkey(store));
    return store;
  }

  it("toggles the overview open AND closed — the reason it is not in hotkeys.ts's guarded table", async () => {
    const store = await hotkeys();
    fireEvent.keyDown(window, { code: "Space", key: " ", metaKey: true, shiftKey: true });
    expect(store.getState().spacesOpen).toBe(true);
    fireEvent.keyDown(window, { code: "Space", key: " ", metaKey: true, shiftKey: true });
    expect(store.getState().spacesOpen).toBe(false);
  });

  it("needs the shift: plain ⌘Space is the platform's, and must pass straight through", async () => {
    const store = await hotkeys();
    fireEvent.keyDown(window, { code: "Space", key: " ", metaKey: true });
    expect(store.getState().spacesOpen).toBe(false);
  });

  it("a modal sheet owns the keyboard outright", async () => {
    const store = await hotkeys();
    act(() => store.getState().openSheet({ kind: "new-space" }));
    fireEvent.keyDown(window, { code: "Space", key: " ", metaKey: true, shiftKey: true });
    expect(store.getState().spacesOpen).toBe(false);
  });

  it("opening it closes the palette — one overlay at a time", async () => {
    const store = await hotkeys();
    act(() => store.getState().setPaletteOpen(true));
    fireEvent.keyDown(window, { code: "Space", key: " ", metaKey: true, shiftKey: true });
    expect(store.getState().paletteOpen).toBe(false);
    expect(store.getState().spacesOpen).toBe(true);
  });
});
