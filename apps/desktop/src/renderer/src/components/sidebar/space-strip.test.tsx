import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { SpaceStrip } from "./SpaceStrip";
import { StoreContext, createAppStore, spaceBadge } from "../../state/store";
import { fakeApi, session } from "../../state/store.test-fakes";

async function mount(api = fakeApi()) {
  const store = createAppStore(api);
  await store.getState().boot();
  const r = render(<StoreContext.Provider value={store}><SpaceStrip /></StoreContext.Provider>);
  return { store, api, ...r };
}

describe("SpaceStrip overflow (A-H2)", () => {
  // jsdom has no layout, so scrolling can't be observed — assert the effect's call instead.
  const scrollSpy = vi.fn();
  beforeEach(() => {
    (Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = scrollSpy;
    scrollSpy.mockClear();
  });

  it("scrolls the active space's button into view on mount and again on every activation", async () => {
    await mount();
    await waitFor(() => expect(scrollSpy).toHaveBeenCalledWith({ inline: "nearest", block: "nearest" }));
    expect(scrollSpy.mock.contexts.at(-1)).toBe(screen.getByRole("button", { name: /switch to space Versed/i }));
    scrollSpy.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /switch to space Homework/i }));
    await waitFor(() => expect(scrollSpy).toHaveBeenCalledWith({ inline: "nearest", block: "nearest" }));
    expect(scrollSpy.mock.contexts.at(-1)).toBe(screen.getByRole("button", { name: /switch to space Homework/i }));
  });
});

describe("spaceBadge priority (U-H3)", () => {
  const space = { a: "s1", b: "s1", c: "s1", other: "s2" };
  it("waiting_permission beats error beats running; idle/ended never badge; other spaces never leak in", () => {
    expect(spaceBadge({ a: "running", b: "error", c: "waiting_permission" }, space, "s1")).toBe("waiting_permission");
    expect(spaceBadge({ a: "running", b: "error" }, space, "s1")).toBe("error");
    expect(spaceBadge({ a: "running", b: "idle" }, space, "s1")).toBe("running");
    expect(spaceBadge({ a: "idle", b: "ended" }, space, "s1")).toBeNull();
    expect(spaceBadge({ other: "waiting_permission" }, space, "s1")).toBeNull();
    expect(spaceBadge({ other: "waiting_permission" }, space, "s2")).toBe("waiting_permission");
  });
});

describe("SpaceStrip badges (U-H3)", () => {
  it("a status broadcast for an INACTIVE space's session badges that space's button", async () => {
    const api = fakeApi({ sessions: [session("se2", "s2", { status: "idle" })] });
    const { store } = await mount(api);
    expect(store.getState().activeSpaceId).toBe("s1");
    await waitFor(() => expect(store.getState().sessionSpace.se2).toBe("s2")); // boot seeded the map
    const s2btn = () => screen.getByRole("button", { name: /switch to space Homework/i });
    expect(s2btn().querySelector(".strip-badge")).toBeNull(); // idle: no badge
    act(() => store.getState().applySessionStatus("se2", "running"));
    expect(s2btn().querySelector(".strip-badge")).toHaveAttribute("data-status", "running");
    act(() => store.getState().applySessionStatus("se2", "waiting_permission"));
    expect(s2btn().querySelector(".strip-badge")).toHaveAttribute("data-status", "waiting_permission");
    expect(screen.getByRole("button", { name: /switch to space Versed/i }).querySelector(".strip-badge")).toBeNull();
    act(() => store.getState().applySessionStatus("se2", "idle"));
    expect(s2btn().querySelector(".strip-badge")).toBeNull();
  });

  it("a broadcast for a session created after boot triggers a refetch that learns its space", async () => {
    const api = fakeApi();
    const { store } = await mount(api);
    expect(store.getState().sessionSpace.seNew).toBeUndefined();
    api.data.sessions.push(session("seNew", "s2", { status: "running" }));
    act(() => store.getState().applySessionStatus("seNew", "running"));
    await waitFor(() => expect(store.getState().sessionSpace.seNew).toBe("s2"));
    expect(screen.getByRole("button", { name: /switch to space Homework/i }).querySelector(".strip-badge"))
      .toHaveAttribute("data-status", "running");
  });
});

describe("SpaceStrip settings gear (U-M9, retargeted by W6)", () => {
  const settingsItem = (store: { getState(): { items: { kind: string; id: string }[] } }) =>
    store.getState().items.find((i) => i.kind === "settings-page");

  it("opens the SETTINGS page, not the space page — the gear was overloaded (W3's interim wiring)", async () => {
    const { store } = await mount();
    expect(store.getState().activeSpaceId).toBe("s1");
    const gear = screen.getByRole("button", { name: "Settings" });
    expect(gear).toBeEnabled();
    fireEvent.click(gear);
    await waitFor(() => expect(settingsItem(store)).toBeDefined());
    // The page is IN the layout, not merely created; it is a pane, never a sheet; and the SPACE page
    // did not open — that one keeps its own entry points (header, palette "Open space").
    expect(JSON.stringify(store.getState().layout)).toContain(settingsItem(store)!.id);
    expect(store.getState().sheet).toBeNull();
    expect(store.getState().items.find((i) => i.kind === "space-page")).toBeUndefined();
  });

  it("lands the page in the ACTIVE space's layout, and is disabled with no space at all", async () => {
    const { store, api } = await mount();
    fireEvent.click(screen.getByRole("button", { name: /switch to space Homework/i }));
    await waitFor(() => expect(store.getState().activeSpaceId).toBe("s2"));
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    await waitFor(() => expect(settingsItem(store)).toBeDefined());
    // The item row lives in s2 — the space that was active under the click.
    expect((api.data.items.s2 ?? []).some((i) => i.kind === "settings-page")).toBe(true);
    expect((api.data.items.s1 ?? []).some((i) => i.kind === "settings-page")).toBe(false);

    const empty = await mount(fakeApi({ spaces: [], items: {} }));
    expect(empty.store.getState().activeSpaceId).toBeNull();
    const gears = screen.getAllByRole("button", { name: "Settings" });
    expect(gears.at(-1)).toBeDisabled();
    fireEvent.click(gears.at(-1)!);
    expect(empty.store.getState().items).toEqual([]);
  });
});
