import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { SpaceStrip } from "./SpaceStrip";
import { StoreContext, createAppStore, spaceBadge } from "../../state/store";
import { fakeApi, session, space } from "../../state/store.test-fakes";

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

describe("SpaceStrip selection", () => {
  it("uses the active button treatment without rendering a dot below the icon", async () => {
    const { container } = await mount();
    expect(screen.getByRole("button", { name: /switch to space Versed/i })).toHaveAttribute("data-active", "true");
    expect(container.querySelector(".strip-dot")).toBeNull();
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

describe("SpaceStrip profile scoping", () => {
  const twoProfiles = () => fakeApi({
    spaces: [space("s1", "p1", "Versed"), space("s2", "p1", "Homework"), space("s3", "p2", "Thesis")],
    items: { s1: [], s2: [], s3: [] },
  });

  it("shows only the ACTIVE profile's spaces, and follows the active space across a profile change", async () => {
    const { store } = await mount(twoProfiles());
    expect(screen.getByRole("button", { name: /switch to space Versed/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /switch to space Homework/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /switch to space Thesis/i })).toBeNull();
    await act(async () => { await store.getState().selectSpace("s3"); });
    expect(screen.getByRole("button", { name: /switch to space Thesis/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /switch to space Versed/i })).toBeNull();
  });

  it("the chip names the active profile and switches to another profile's remembered space", async () => {
    const { store } = await mount(twoProfiles());
    expect(screen.getByRole("button", { name: "Profile: Work" })).toBeInTheDocument();
    // Go to School and back, so p1 has a remembered space that is NOT its first.
    await act(async () => { await store.getState().selectSpace("s2"); });
    await act(async () => { await store.getState().selectSpace("s3"); });
    expect(screen.getByRole("button", { name: "Profile: School" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Profile: School" }));
    fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: /Work/ }));
    // Where it left off (s2), not p1's first space — the named mutant is falling back to spaces[0].
    await waitFor(() => expect(store.getState().activeSpaceId).toBe("s2"));
  });

  it("a profile with no spaces is listed but not selectable — there would be nothing to land on", async () => {
    const { store } = await mount(); // p2 "School" is empty in the default fixture
    fireEvent.click(screen.getByRole("button", { name: "Profile: Work" }));
    const school = await screen.findByRole("menuitemcheckbox", { name: /School \(empty\)/ });
    expect(school).toBeDisabled();
    fireEvent.click(school);
    expect(store.getState().activeSpaceId).toBe("s1");
  });

  it("a drag reorders WITHIN the profile and leaves every other profile's order untouched", async () => {
    const api = twoProfiles();
    const { store } = await mount(api);
    const versed = screen.getByRole("button", { name: /switch to space Versed/i });
    const homework = screen.getByRole("button", { name: /switch to space Homework/i });
    const dt = { effectAllowed: "", setData: () => {}, getData: () => "s1" };
    fireEvent.dragStart(versed, { dataTransfer: dt });
    fireEvent.dragOver(homework, { dataTransfer: dt });
    fireEvent.drop(homework, { dataTransfer: dt });
    // s3 keeps its slot: the named mutant is concatenating the profile's spaces onto the front of
    // the list, which silently resequences every other profile.
    await waitFor(() => expect(store.getState().spaces.map((sp) => sp.id)).toEqual(["s2", "s1", "s3"]));
    expect(api.calls.filter((c) => c.startsWith("reorderSpaces:")).at(-1)).toBe("reorderSpaces:s2,s1,s3");
  });

  it("the gear is gone from the strip — Settings is a destination row now", async () => {
    await mount();
    expect(screen.queryByRole("button", { name: "Settings" })).toBeNull();
  });
});
