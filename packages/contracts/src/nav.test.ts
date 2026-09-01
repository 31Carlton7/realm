import { describe, expect, it } from "vitest";
import { canNav, forgetNavItems, navEntry, NAV_HISTORY_LIMIT, pushNav, reconcileNav, stepNav, type PaneHistory } from "./nav";
import type { Layout } from "./layout";
import type { SpaceGroups } from "./groups";

const leaf = (id: string, itemId: string | null): Layout => ({ type: "leaf", id, itemId });
const split = (id: string, ...children: Layout[]): Layout =>
  ({ type: "split", id, dir: "row", sizes: children.map(() => 100 / children.length), children });
const groups = (...layouts: Layout[]): SpaceGroups => ({
  groups: layouts.map((l, i) => ({ id: `g${i + 1}`, name: `G${i + 1}`, layout: l, zoomedLeafId: null })),
  activeGroupId: "g1",
});

describe("a pane's back/forward trail", () => {
  it("records stops, and stepping walks them without changing them", () => {
    let h: PaneHistory = {};
    h = pushNav(h, "l1", { itemId: "a", view: null });
    h = pushNav(h, "l1", { itemId: "b", view: null });
    h = pushNav(h, "l1", { itemId: "c", view: null });
    expect(navEntry(h, "l1")).toEqual({ itemId: "c", view: null });

    const back = stepNav(stepNav(h, "l1", -1), "l1", -1);
    expect(navEntry(back, "l1")).toEqual({ itemId: "a", view: null });
    expect(navEntry(stepNav(back, "l1", 1), "l1")).toEqual({ itemId: "b", view: null });
    // The entries themselves are untouched by walking — only the cursor moved.
    expect(back.l1!.entries).toEqual(h.l1!.entries);
  });

  it("refuses to step off either end, returning the SAME object so callers can skip the write", () => {
    const h = pushNav({}, "l1", { itemId: "a", view: null });
    expect(canNav(h, "l1", -1)).toBe(false);
    expect(canNav(h, "l1", 1)).toBe(false);
    expect(stepNav(h, "l1", -1)).toBe(h);
    expect(stepNav(h, "l1", 1)).toBe(h);
    // …and a leaf that has never held anything has nowhere to go in either direction.
    expect(canNav(h, "l-unknown", -1)).toBe(false);
    expect(canNav({}, null, 1)).toBe(false);
    expect(navEntry({}, null)).toBeNull();
  });

  it("treats the item AND the view as the stop's identity — a view change is its own stop", () => {
    let h: PaneHistory = {};
    h = pushNav(h, "l1", { itemId: "np", view: null });
    h = pushNav(h, "l1", { itemId: "np", view: "n7" });
    expect(h.l1!.entries).toHaveLength(2);
    expect(navEntry(stepNav(h, "l1", -1), "l1")).toEqual({ itemId: "np", view: null });
    // Arriving where you already stand is not a stop — the guard the reconcile-on-every-write leans on.
    expect(pushNav(h, "l1", { itemId: "np", view: "n7" })).toBe(h);
  });

  it("forks the trail: a new stop from the middle drops the forward run", () => {
    let h: PaneHistory = {};
    for (const id of ["a", "b", "c"]) h = pushNav(h, "l1", { itemId: id, view: null });
    h = stepNav(h, "l1", -1); // standing on b, with c ahead
    h = pushNav(h, "l1", { itemId: "d", view: null });
    expect(h.l1!.entries.map((e) => e.itemId)).toEqual(["a", "b", "d"]);
    expect(canNav(h, "l1", 1)).toBe(false); // c is gone, not merely skipped
  });

  it("caps the trail from the OLD end, so the cap never costs you the step you just took", () => {
    let h: PaneHistory = {};
    for (let i = 0; i < NAV_HISTORY_LIMIT + 10; i++) h = pushNav(h, "l1", { itemId: `i${i}`, view: null });
    expect(h.l1!.entries).toHaveLength(NAV_HISTORY_LIMIT);
    expect(navEntry(h, "l1")).toEqual({ itemId: `i${NAV_HISTORY_LIMIT + 9}`, view: null });
    expect(h.l1!.entries[0]).toEqual({ itemId: "i10", view: null }); // i0…i9 fell off the far past
  });

  it("keeps each leaf's trail its own — a split navigates independently of its neighbour", () => {
    let h: PaneHistory = {};
    h = pushNav(h, "l1", { itemId: "a", view: null });
    h = pushNav(h, "l2", { itemId: "b", view: null });
    h = pushNav(h, "l1", { itemId: "c", view: null });
    expect(navEntry(h, "l1")).toEqual({ itemId: "c", view: null });
    expect(navEntry(h, "l2")).toEqual({ itemId: "b", view: null });
    expect(canNav(h, "l2", -1)).toBe(false);
  });
});

describe("reconcileNav — the one recording site", () => {
  it("records a leaf's new occupant as a stop, whatever changed it", () => {
    const h = reconcileNav({}, groups(split("s", leaf("l1", "a"), leaf("l2", "b"))));
    expect(navEntry(h, "l1")).toEqual({ itemId: "a", view: null });
    expect(navEntry(h, "l2")).toEqual({ itemId: "b", view: null });
    // The pane's item is replaced (openItem, a drop, a preset) — the trail grows, Back is armed.
    const after = reconcileNav(h, groups(split("s", leaf("l1", "c"), leaf("l2", "b"))));
    expect(after.l1!.entries.map((e) => e.itemId)).toEqual(["a", "c"]);
    expect(canNav(after, "l1", -1)).toBe(true);
    expect(after.l2!.entries).toHaveLength(1); // the untouched pane records nothing
  });

  it("is idempotent — a resize or an unrelated write does not stuff the stack", () => {
    const g = groups(leaf("l1", "a"));
    const h = reconcileNav({}, g);
    expect(reconcileNav(h, g)).toBe(h);
    expect(reconcileNav(reconcileNav(h, g), g).l1!.entries).toHaveLength(1);
  });

  it("THE stall mutant: a step Back records nothing, so pressing Back twice moves twice", () => {
    // Standing on b with a behind; the step seats the cursor on a and swaps the leaf's item to a.
    let h = reconcileNav({}, groups(leaf("l1", "a")));
    h = reconcileNav(h, groups(leaf("l1", "b")));
    h = stepNav(h, "l1", -1);
    const afterWrite = reconcileNav(h, groups(leaf("l1", "a")));
    expect(afterWrite.l1!.entries.map((e) => e.itemId)).toEqual(["a", "b"]); // no third entry
    expect(afterWrite.l1!.index).toBe(0);
    expect(canNav(afterWrite, "l1", 1)).toBe(true); // b is still ahead — the trail was not forked
  });

  it("THE view-clobber mutant: a pane parked on an in-pane view is not 'news' on an unrelated write", () => {
    // The pane holds the notifications page and the user has opened row n7. A resize, a split, a
    // group switch — any layout write — must not read that as the pane having moved back to the bare
    // list and push `{np, null}` over the forward run.
    let h = reconcileNav({}, groups(leaf("l1", "np")));
    h = pushNav(h, "l1", { itemId: "np", view: "n7" });
    const after = reconcileNav(h, groups(leaf("l1", "np")));
    expect(after).toBe(h);
    expect(navEntry(after, "l1")).toEqual({ itemId: "np", view: "n7" });

    // …and the same holds mid-trail: stepping BACK onto the bare list leaves n7 reachable by Forward.
    const back = reconcileNav(stepNav(h, "l1", -1), groups(leaf("l1", "np")));
    expect(navEntry(back, "l1")).toEqual({ itemId: "np", view: null });
    expect(canNav(back, "l1", 1)).toBe(true);
    expect(back.l1!.entries).toHaveLength(2);
  });

  it("keeps the trails of groups that are off screen, and forgets leaves that are truly gone", () => {
    const two = groups(leaf("l1", "a"), leaf("l2", "b"));
    let h = reconcileNav({}, two);
    expect(Object.keys(h).sort()).toEqual(["l1", "l2"]);
    // Switching groups changes nothing structural — both arrangements still exist, so both remember.
    h = reconcileNav(h, { ...two, activeGroupId: "g2" });
    expect(Object.keys(h).sort()).toEqual(["l1", "l2"]);
    // Removing the group (or leaving the space) does forget it.
    expect(Object.keys(reconcileNav(h, groups(leaf("l1", "a"))))).toEqual(["l1"]);
    expect(Object.keys(reconcileNav(h, null))).toEqual([]);
  });

  it("an emptied leaf keeps the trail it had — closing a pane does not erase where it had been", () => {
    let h = reconcileNav({}, groups(leaf("l1", "a")));
    h = reconcileNav(h, groups(leaf("l1", "b")));
    const closed = reconcileNav(h, groups(leaf("l1", null)));
    expect(closed.l1!.entries.map((e) => e.itemId)).toEqual(["a", "b"]);
  });
});

describe("forgetNavItems — a deleted item leaves no way back to it", () => {
  it("drops its entries and keeps the cursor on the stop it was standing on", () => {
    let h: PaneHistory = {};
    for (const id of ["a", "gone", "c"]) h = pushNav(h, "l1", { itemId: id, view: null });
    h = stepNav(h, "l1", -2); // standing on a
    const kept = forgetNavItems(h, new Set(["a", "c"]));
    expect(kept.l1!.entries.map((e) => e.itemId)).toEqual(["a", "c"]);
    expect(navEntry(kept, "l1")).toEqual({ itemId: "a", view: null }); // still on a, not shifted onto c
  });

  it("clamps when the deleted item is the one the pane was showing", () => {
    let h: PaneHistory = {};
    for (const id of ["a", "b", "gone"]) h = pushNav(h, "l1", { itemId: id, view: null });
    const kept = forgetNavItems(h, new Set(["a", "b"]));
    expect(navEntry(kept, "l1")).toEqual({ itemId: "b", view: null });
    expect(canNav(kept, "l1", 1)).toBe(false);
  });

  it("drops the leaf entirely when its whole trail was deleted, and no-ops when nothing was", () => {
    const h = pushNav(pushNav({}, "l1", { itemId: "a", view: null }), "l2", { itemId: "b", view: null });
    expect(Object.keys(forgetNavItems(h, new Set(["b"])))).toEqual(["l2"]);
    expect(forgetNavItems(h, new Set(["a", "b"]))).toBe(h);
  });
});
