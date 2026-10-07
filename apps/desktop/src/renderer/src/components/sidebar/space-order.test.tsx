import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Sidebar } from "./Sidebar";
import { StoreContext, createAppStore, spaceActivity, spaceBadge } from "../../state/store";
import { fakeApi, session, space } from "../../state/store.test-fakes";

/**
 * Which spaces the list shows, in what order, and what keeps the order honest — what the space strip
 * used to be tested for, now that the spaces are sections of the sidebar's list (Plan 27).
 */

async function mount(api = fakeApi()) {
  const store = createAppStore(api);
  await store.getState().boot();
  const r = render(<StoreContext.Provider value={store}><Sidebar /></StoreContext.Provider>);
  return { store, api, ...r };
}

afterEach(() => cleanup());

const order = (container: HTMLElement) => [...container.querySelectorAll(".sb-section")].map((s) => s.getAttribute("aria-label"));
const headOf = (name: string) => screen.getByRole("region", { name }).querySelector<HTMLElement>(".sb-section-head")!;

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

describe("spaceActivity, the sort key behind \"Sort spaces by activity\"", () => {
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

/** Two spaces of one profile: Versed with an older session, Homework with a newer one. */
const twoSpaces = () => fakeApi({
  spaces: [space("s1", "p1", "Versed"), space("s2", "p1", "Homework")],
  sessions: [session("se1", "s1", { status: "idle", updatedAt: 100 }), session("se2", "s2", { status: "idle", updatedAt: 200 })],
  items: { s1: [], s2: [] },
});

/**
 * The half `spaceActivity` cannot see on its own: something has to KEEP `sessionUpdatedAt` current.
 * `applySessionStatus` patches status locally rather than refetching, so without a stamp there the
 * timestamps sit at whatever the last list said — a "sort by activity" that does not follow activity.
 */
describe("what keeps sessionUpdatedAt current", () => {
  it("a status CHANGE moves the session's space to the front of the order", async () => {
    const { container, store } = await mount(twoSpaces());
    await waitFor(() => expect(store.getState().sessionUpdatedAt.se2).toBe(200));
    await act(async () => { await store.getState().setSidebarActivityOrder(true); });
    expect(order(container)).toEqual(["Homework", "Versed"]);
    act(() => store.getState().applySessionStatus("se1", "running"));
    expect(store.getState().sessionUpdatedAt.se1).toBeGreaterThan(200);
    expect(order(container)).toEqual(["Versed", "Homework"]);
  });

  it("a repeat of the same status is a broadcast, not movement", async () => {
    const { store } = await mount(twoSpaces());
    await waitFor(() => expect(store.getState().sessionUpdatedAt.se1).toBe(100));
    act(() => store.getState().applySessionStatus("se1", "idle")); // already idle
    expect(store.getState().sessionUpdatedAt.se1).toBe(100);
  });
});

describe("a section's state, live from every space (U-H3)", () => {
  it("a status broadcast for a session in a space not on screen shows on that space's head", async () => {
    const { store } = await mount(fakeApi({ sessions: [session("se2", "s2", { status: "idle" })] }));
    expect(store.getState().activeSpaceId).toBe("s1");
    await waitFor(() => expect(store.getState().sessionSpace.se2).toBe("s2"));
    const homework = () => within(headOf("Homework")).getByRole("button", { name: /^Homework/ });
    expect(homework()).toHaveAccessibleName("Homework");
    act(() => store.getState().applySessionStatus("se2", "running"));
    expect(homework()).toHaveAccessibleName("Homework — 1 running");
    act(() => store.getState().applySessionStatus("se2", "waiting_permission"));
    expect(homework()).toHaveAccessibleName("Homework — 1 waiting on you");
    expect(homework().querySelector(".item-trail .status-dot")).toHaveAttribute("data-status", "waiting_permission");
    expect(within(headOf("Versed")).getByRole("button", { name: /^Versed/ })).toHaveAccessibleName("Versed");
  });

  it("a broadcast for a session made after boot triggers a refetch that learns its space", async () => {
    const api = fakeApi();
    const { store } = await mount(api);
    api.data.sessions.push(session("seNew", "s2", { status: "running" }));
    act(() => store.getState().applySessionStatus("seNew", "running"));
    await waitFor(() => expect(store.getState().sessionSpace.seNew).toBe("s2"));
    expect(within(headOf("Homework")).getByRole("button", { name: /^Homework/ })).toHaveAccessibleName("Homework — 1 running");
  });
});

describe("sorted by activity", () => {
  it("leaves the arranged order alone until the setting is turned on", async () => {
    const { container, store } = await mount(twoSpaces());
    await waitFor(() => expect(store.getState().sessionUpdatedAt.se2).toBe(200));
    expect(order(container)).toEqual(["Versed", "Homework"]);
  });

  it("turning it on re-sorts without writing a new order, and back off restores it", async () => {
    const { container, store } = await mount(twoSpaces());
    await waitFor(() => expect(store.getState().sessionUpdatedAt.se2).toBe(200));
    await act(async () => { await store.getState().setSidebarActivityOrder(true); });
    expect(order(container)).toEqual(["Homework", "Versed"]);
    expect(store.getState().spaces.map((sp) => sp.id)).toEqual(["s1", "s2"]); // sort_order untouched
    await act(async () => { await store.getState().setSidebarActivityOrder(false); });
    expect(order(container)).toEqual(["Versed", "Homework"]);
  });

  /* `draggable` is browser-enforced — jsdom fires drag events regardless — so the attribute itself is
     the honest thing to assert. A drop into a spot the next status change would re-sort away from is a
     drop that looks like it did nothing. */
  it("turns off dragging the heads while the setting is on, and gives it back when it's off", async () => {
    const { store } = await mount(twoSpaces());
    expect(headOf("Homework")).toHaveAttribute("draggable", "true");
    await act(async () => { await store.getState().setSidebarActivityOrder(true); });
    expect(headOf("Homework")).toHaveAttribute("draggable", "false");
    await act(async () => { await store.getState().setSidebarActivityOrder(false); });
    expect(headOf("Homework")).toHaveAttribute("draggable", "true");
  });
});

describe("the profile's spaces, and only its", () => {
  const twoProfiles = () => fakeApi({
    spaces: [space("s1", "p1", "Versed"), space("s2", "p1", "Homework"), space("s3", "p2", "Thesis")],
    items: { s1: [], s2: [], s3: [] },
  });

  it("lists only the ACTIVE profile's spaces, and follows the profile when it changes", async () => {
    const { container, store } = await mount(twoProfiles());
    expect(order(container)).toEqual(["Versed", "Homework"]);
    await act(async () => { await store.getState().selectSpace("s3"); });
    expect(order(container)).toEqual(["Thesis"]);
  });

  it("switching back lands on the space the profile was left on", async () => {
    const { store } = await mount(twoProfiles());
    await act(async () => { await store.getState().selectSpace("s2"); });
    await act(async () => { await store.getState().selectSpace("s3"); });
    fireEvent.click(within(document.querySelector<HTMLElement>(".sb-title")!).getByRole("button", { name: "Profile: School" }));
    fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: /Work/ }));
    // Where it left off (s2), not the profile's first space — the named mutant is falling back to spaces[0].
    await waitFor(() => expect(store.getState().activeSpaceId).toBe("s2"));
  });

  it("a head dragged onto another reorders WITHIN the profile and leaves every other profile's order alone", async () => {
    const api = twoProfiles();
    const { store } = await mount(api);
    const dt = { effectAllowed: "", types: ["application/x-realm-space"], setData: () => {}, getData: () => "s1" };
    fireEvent.dragStart(headOf("Versed"), { dataTransfer: dt });
    fireEvent.dragOver(headOf("Homework"), { dataTransfer: dt });
    expect(headOf("Homework")).toHaveAttribute("data-drag-over");
    fireEvent.drop(headOf("Homework"), { dataTransfer: dt });
    // s3 keeps its slot: the named mutant concatenates the profile's spaces onto the front of the
    // list, which silently resequences every other profile.
    await waitFor(() => expect(store.getState().spaces.map((sp) => sp.id)).toEqual(["s2", "s1", "s3"]));
    expect(api.calls.filter((c) => c.startsWith("reorderSpaces:")).at(-1)).toBe("reorderSpaces:s2,s1,s3");
  });

  it("ignores a drag that is not a space's — a session row dropped on a head moves nothing", async () => {
    const api = twoProfiles();
    await mount(api);
    const dt = { effectAllowed: "", types: ["application/x-realm-item"], setData: () => {}, getData: () => "i1" };
    fireEvent.dragOver(headOf("Homework"), { dataTransfer: dt });
    expect(headOf("Homework")).not.toHaveAttribute("data-drag-over");
    fireEvent.drop(headOf("Homework"), { dataTransfer: dt });
    expect(api.calls.some((c) => c.startsWith("reorderSpaces:"))).toBe(false);
  });
});
