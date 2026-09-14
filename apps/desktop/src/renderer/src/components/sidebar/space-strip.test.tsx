import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react";
import { SpaceStrip } from "./SpaceStrip";
import { StoreContext, createAppStore, spaceActivity, spaceBadge } from "../../state/store";
import { fakeApi, session, space } from "../../state/store.test-fakes";
import { exited } from "../popover-exit.test-fakes";

async function mount(api = fakeApi()) {
  const store = createAppStore(api);
  await store.getState().boot();
  const r = render(<StoreContext.Provider value={store}><SpaceStrip /></StoreContext.Provider>);
  return { store, api, ...r };
}

describe("SpaceStrip overflow (A-H2)", () => {
  /* jsdom has no layout, so the geometry the effect reads is staged by hand: a 100px rail holding
     300px of chips, with the second space sitting off the right-hand end. */
  const layout = (el: Element, props: Record<string, number>) => {
    for (const [k, v] of Object.entries(props)) Object.defineProperty(el, k, { value: v, configurable: true, writable: true });
  };
  const stage = (container: HTMLElement, { scrollLeft = 0, chipLeft = 200 } = {}) => {
    const rail = container.querySelector<HTMLElement>(".strip-spaces")!;
    layout(rail, { clientWidth: 100, scrollWidth: 300, scrollLeft });
    const chip = screen.getByRole("button", { name: /switch to space Homework/i });
    layout(chip, { offsetLeft: chipLeft, offsetWidth: 30, clientWidth: 30 });
    return rail;
  };

  it("scrolls the active space into view — and stops there, having moved the least it could", async () => {
    /* It was `scrollIntoView`, which teleports. On a strip of identical 30px squares a jump has no
       landmark to track, so the row simply IS somewhere else. The spring is the same one the pages
       move on, and it lands on the nearest edge plus a chip of air rather than centring — a strip
       that recentred itself on every activation would never stop moving. */
    const { container } = await mount();
    const rail = stage(container);
    fireEvent.click(screen.getByRole("button", { name: /switch to space Homework/i }));
    // 230 (the chip's right edge) + 30 of air, less the 100px rail.
    await waitFor(() => expect(rail.scrollLeft).toBeCloseTo(160, 0), { timeout: 3000 });
  });

  it("does nothing at all when the space is already in view", async () => {
    /* Chrome that shifts for no reason is worse than chrome that does not move. "In view" means the
       chip AND its air: at scrollLeft 140 the rail shows 140–240, and a chip at 175–205 clears both
       edges by the 30px the rule asks for. */
    const { container } = await mount();
    const rail = stage(container, { scrollLeft: 140, chipLeft: 175 });
    fireEvent.click(screen.getByRole("button", { name: /switch to space Homework/i }));
    await new Promise((r) => setTimeout(r, 120));
    expect(rail.scrollLeft).toBe(140);
  });

  it("the user wins: a touch of the trackpad abandons the animation where it stands", async () => {
    const { container } = await mount();
    const rail = stage(container);
    fireEvent.click(screen.getByRole("button", { name: /switch to space Homework/i }));
    await waitFor(() => expect(rail.scrollLeft).toBeGreaterThan(1));
    fireEvent.wheel(rail, { deltaX: 10 });
    const abandoned = rail.scrollLeft;
    await new Promise((r) => setTimeout(r, 150));
    expect(rail.scrollLeft).toBe(abandoned); // never dragged back to the target
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

describe("spaceActivity, the sort key behind \"Sort by activity\"", () => {
  const space = { a: "s1", b: "s1", c: "s2" };

  it("ranks the space with the newest activity first", () => {
    const updated = { a: 100, b: 50 };
    expect(spaceActivity({}, space, updated, "s1")).toBe(100); // the newer of a/b, not their sum
    expect(spaceActivity({}, space, updated, "s2")).toBe(0); // c never reported one
  });

  it("waiting_permission outranks every timestamp — even an old question beats a fresh touch", () => {
    const updated = { a: 1, c: 999_999 };
    expect(spaceActivity({ a: "waiting_permission" }, space, updated, "s1")).toBe(Infinity);
    expect(spaceActivity({ a: "waiting_permission" }, space, updated, "s1"))
      .toBeGreaterThan(spaceActivity({}, space, updated, "s2"));
  });

  it("a session in another space never lends its timestamp", () => {
    expect(spaceActivity({}, space, { c: 500 }, "s1")).toBe(0);
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

describe("SpaceStrip, sorted by activity", () => {
  const twoSpaces = () => fakeApi({
    spaces: [space("s1", "p1", "Versed"), space("s2", "p1", "Homework")],
    sessions: [session("se1", "s1", { status: "idle", updatedAt: 100 }), session("se2", "s2", { status: "idle", updatedAt: 200 })],
    items: { s1: [], s2: [] },
  });
  const order = (container: HTMLElement) => [...container.querySelectorAll(".strip-space")].map((b) => b.getAttribute("aria-label"));

  it("leaves the strip's own order alone until the setting is turned on", async () => {
    const { container, store } = await mount(twoSpaces());
    await waitFor(() => expect(store.getState().sessionUpdatedAt.se2).toBe(200));
    // s1 before s2, the drag order the fixture was given — s2 has the newer session but the setting
    // is off, so recency has no say yet.
    expect(order(container)).toEqual(["Switch to space Versed", "Switch to space Homework"]);
  });

  it("turning it on re-sorts by activity without writing a new drag order, and back off restores it", async () => {
    const { container, store } = await mount(twoSpaces());
    await waitFor(() => expect(store.getState().sessionUpdatedAt.se2).toBe(200));
    await act(async () => { await store.getState().setSidebarActivityOrder(true); });
    expect(order(container)).toEqual(["Switch to space Homework", "Switch to space Versed"]);
    expect(store.getState().spaces.map((sp) => sp.id)).toEqual(["s1", "s2"]); // sort_order untouched
    await act(async () => { await store.getState().setSidebarActivityOrder(false); });
    expect(order(container)).toEqual(["Switch to space Versed", "Switch to space Homework"]);
  });

  it("a question outranks a fresher touch, and the strip re-sorts live as one arrives", async () => {
    const { container, store } = await mount(twoSpaces());
    await act(async () => { await store.getState().setSidebarActivityOrder(true); });
    expect(order(container)).toEqual(["Switch to space Homework", "Switch to space Versed"]);
    act(() => store.getState().applySessionStatus("se1", "waiting_permission"));
    expect(order(container)).toEqual(["Switch to space Versed", "Switch to space Homework"]);
  });

  /* `draggable` is a browser-enforced attribute — jsdom fires drag events regardless of its value,
     so the attribute itself, not a simulated drag, is the honest thing to assert here. A drop into a
     spot the next status change would re-sort away from is a drop that looks like it did nothing,
     which is worse than no affordance at all. */
  it("turns off dragging while the setting is on, and gives it back when it's off again", async () => {
    const { store } = await mount(twoSpaces());
    const homework = () => screen.getByRole("button", { name: /switch to space Homework/i });
    expect(homework()).toHaveAttribute("draggable", "true");
    await act(async () => { await store.getState().setSidebarActivityOrder(true); });
    expect(homework()).toHaveAttribute("draggable", "false");
    await act(async () => { await store.getState().setSidebarActivityOrder(false); });
    expect(homework()).toHaveAttribute("draggable", "true");
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

  it("the gear is not a slot in the strip — it is inside the chip's menu", async () => {
    await mount();
    // No button in the RAIL: the strip is a rail about spaces, and the gear was the one thing in it
    // that was not one. It costs a menu row instead of a slot the strip has none of.
    expect(screen.queryByRole("button", { name: "Settings" })).toBeNull();
  });

  /* The chip is the one control in the column whose subject is the account rather than the work, so
     the two pages that belong to neither a space nor a session are asked for here: what this Mac is
     connected to, and how Realm itself is set up. They open the same overlay the destination rows
     open — one page, one way in, whichever door was used. */
  it("the profile menu opens Connections, Profile and Settings, each wearing its own glyph", async () => {
    const { store } = await mount();
    fireEvent.click(screen.getByRole("button", { name: "Profile: Work" }));
    const menu = await screen.findByRole("menu", { name: "Profiles" });
    for (const name of ["Connections", "Profile", "Settings"]) {
      expect(within(menu).getByRole("menuitem", { name }).querySelector(".menu-icon svg")).not.toBeNull();
    }
    // Every row reserves the slot once any row asks for one, so the profiles carry their own marks
    // rather than starting 20px left of the two rows under them.
    expect(within(menu).getByRole("menuitemcheckbox", { name: /Work/ }).querySelector(".menu-icon svg")).not.toBeNull();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Settings" }));
    await waitFor(() => expect(store.getState().pageOverlay?.kind).toBe("settings-page"));

    // §6's exit keeps the dismissed menu mounted for a beat, and the chip is a toggle: pressing it
    // inside that beat would close what is already closing rather than open it again.
    await exited();
    fireEvent.click(screen.getByRole("button", { name: "Profile: Work" }));
    fireEvent.click(within(await screen.findByRole("menu", { name: "Profiles" })).getByRole("menuitem", { name: "Connections" }));
    await waitFor(() => expect(store.getState().pageOverlay?.kind).toBe("connections-page"));

    /* The profile's own page. Its old door was a pill in the space header naming the profile; that
       pill is gone, and this chip — which is the profile, in its colour — is where it went. */
    await exited();
    fireEvent.click(screen.getByRole("button", { name: "Profile: Work" }));
    fireEvent.click(within(await screen.findByRole("menu", { name: "Profiles" })).getByRole("menuitem", { name: "Profile" }));
    await waitFor(() => expect(store.getState().pageOverlay?.kind).toBe("profile-page"));
  });
});
