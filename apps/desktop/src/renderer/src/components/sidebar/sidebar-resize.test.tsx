import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AppShell } from "../../App";
import { StoreContext, createAppStore, PERSIST_DEBOUNCE_MS } from "../../state/store";
import { fakeApi } from "../../state/store.test-fakes";
import { SIDEBAR_WIDTH } from "./sidebar-width";

const KEY = "ui.sidebarWidth";

/** The shell, not the Sidebar alone: the width is a number the column and the collapse animation
 *  both read off `.app`, so the control and the thing it moves are only together here. */
async function mountShell(over: Parameters<typeof fakeApi>[0] = {}) {
  const api = fakeApi(over);
  const store = createAppStore(api);
  await store.getState().boot();
  const r = render(<StoreContext.Provider value={store}><AppShell /></StoreContext.Provider>);
  return { store, api, ...r };
}

const handle = () => screen.getByRole("separator", { name: "Sidebar width" });
const painted = () => (document.querySelector(".app") as HTMLElement).style.getPropertyValue("--sidebar-w");

/** jsdom implements no PointerEvent, and `fireEvent.pointerDown` falls back to a plain Event — which
 *  carries no `clientX` and no `button`, so a drag staged that way is a gesture with no coordinates
 *  in it. A MouseEvent named `pointerdown` is what React's listener is keyed on and what the handler
 *  actually reads. */
const pointer = (type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel", clientX: number) =>
  fireEvent(handle(), new MouseEvent(type, { bubbles: true, cancelable: true, clientX, button: 0 }));

/** A drag, in the three events a pointer actually sends. */
const drag = (byX: number, from = 280) => {
  pointer("pointerdown", from);
  pointer("pointermove", from + byX);
  pointer("pointerup", from + byX);
};

beforeEach(() => {
  // jsdom implements no pointer capture at all. The drag depends on it — that is what keeps the
  // events coming once the pointer is over a pane — so it is stubbed rather than worked around.
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.hasPointerCapture = () => true;
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("resizing the sidebar", () => {
  it("paints the stored width, and ships 280 when nothing is stored", async () => {
    const { store } = await mountShell();
    expect(store.getState().sidebarWidth).toBe(SIDEBAR_WIDTH.default);
    expect(painted()).toBe("280px");
  });

  it("a stored width comes back on the next launch", async () => {
    const { store } = await mountShell({ settings: { [KEY]: 360 } });
    expect(store.getState().sidebarWidth).toBe(360);
    expect(painted()).toBe("360px");
  });

  it("a stored width outside the range is brought into it rather than painted", async () => {
    // THE trusting-boot mutant: hydrate whatever is in the settings table. A hand-edited 2000 is a
    // sidebar with no window left beside it, and nothing on screen to drag it back with.
    const { store } = await mountShell({ settings: { [KEY]: 2_000 } });
    expect(store.getState().sidebarWidth).toBe(SIDEBAR_WIDTH.max);
    const junk = await mountShell({ settings: { [KEY]: "wide" } });
    expect(junk.store.getState().sidebarWidth).toBe(SIDEBAR_WIDTH.default);
  });

  it("drags wider and narrower, following the pointer pixel for pixel", async () => {
    const { store } = await mountShell();
    drag(+60);
    await waitFor(() => expect(store.getState().sidebarWidth).toBe(340));
    expect(painted()).toBe("340px");
    drag(-100, 340);
    await waitFor(() => expect(store.getState().sidebarWidth).toBe(240));
  });

  it("stops at the maximum however far the pointer goes", async () => {
    // The ask: resizeable, with a ceiling. design.md keeps persistent navigation narrow, and the
    // window can be 900px wide — a column past this leaves the panes less room than a transcript's
    // own measure.
    const { store } = await mountShell();
    drag(+900);
    await waitFor(() => expect(store.getState().sidebarWidth).toBe(SIDEBAR_WIDTH.max));
    expect(painted()).toBe(`${SIDEBAR_WIDTH.max}px`);
  });

  it("stops at the minimum, rather than letting the column collapse by drag", async () => {
    const { store } = await mountShell();
    drag(-900);
    await waitFor(() => expect(store.getState().sidebarWidth).toBe(SIDEBAR_WIDTH.min));
  });

  it("nothing moves until the pointer goes down, and nothing moves after it comes up", async () => {
    const { store } = await mountShell();
    pointer("pointermove", 900);
    expect(painted()).toBe("280px");
    drag(+40);
    await waitFor(() => expect(store.getState().sidebarWidth).toBe(320));
    pointer("pointermove", 900);
    expect(painted()).toBe("320px");
  });

  it("measures the drag from where it started, so a gesture that returns lands where it began", async () => {
    // THE live-width mutant: add the delta to the CURRENT width on every move. Each move would
    // compound the last and the column would run away from the pointer.
    const { store } = await mountShell();
    pointer("pointerdown", 500);
    for (const x of [520, 560, 600, 540]) pointer("pointermove", x);
    expect(painted()).toBe("320px");
    pointer("pointermove", 500);
    expect(painted()).toBe("280px");
    pointer("pointerup", 500);
    await waitFor(() => expect(store.getState().sidebarWidth).toBe(SIDEBAR_WIDTH.default));
  });

  it("moves the column without re-rendering the shell behind it", async () => {
    // THE store-per-move mutant: set the width through React on every pointermove. The variable
    // lives on `.app`, so each move would re-render the sidebar, the pane host and every pane in
    // it — a hundred times a second, for a number in a style attribute. What proves the difference
    // is that the column tracks the pointer while the store has not heard anything yet.
    const { store } = await mountShell();
    pointer("pointerdown", 300);
    for (let x = 304; x <= 340; x += 4) pointer("pointermove", x);
    expect(painted()).toBe("320px");
    expect(store.getState().sidebarWidth).toBe(SIDEBAR_WIDTH.default);
    pointer("pointerup", 340);
    await waitFor(() => expect(store.getState().sidebarWidth).toBe(320));
  });

  it("writes the width once the gesture settles, not once per pixel of it", async () => {
    const { api, store } = await mountShell();
    pointer("pointerdown", 300);
    for (let x = 304; x <= 340; x += 4) pointer("pointermove", x);
    pointer("pointerup", 340);
    await waitFor(() => expect(store.getState().sidebarWidth).toBe(320));
    // Polled rather than slept through: the debounce is a real timer, and a fixed wait of exactly
    // its length is a test that fails on a loaded machine for a reason that is not the code.
    await waitFor(() => expect(api.data.settings[KEY]).toBe(320), { timeout: PERSIST_DEBOUNCE_MS * 10 });
    expect(api.calls.filter((c) => c.startsWith(`setSetting:${KEY}`))).toHaveLength(1);
  });

  it("does the same work from the keyboard, including the ends of the range", async () => {
    // A separator with a value that only a pointer can move is a control half the people who need
    // it cannot reach.
    const { store } = await mountShell();
    handle().focus();
    // Consumed, which is the other half of the job: an arrow that reached the shell behind it would
    // scroll a list at the same time as it moved the column.
    expect(fireEvent.keyDown(handle(), { key: "ArrowRight" })).toBe(false);
    await waitFor(() => expect(store.getState().sidebarWidth).toBe(296));
    fireEvent.keyDown(handle(), { key: "ArrowLeft" });
    await waitFor(() => expect(store.getState().sidebarWidth).toBe(280));
    fireEvent.keyDown(handle(), { key: "ArrowRight", shiftKey: true });
    await waitFor(() => expect(store.getState().sidebarWidth).toBe(281));
    fireEvent.keyDown(handle(), { key: "End" });
    await waitFor(() => expect(store.getState().sidebarWidth).toBe(SIDEBAR_WIDTH.max));
    fireEvent.keyDown(handle(), { key: "Home" });
    await waitFor(() => expect(store.getState().sidebarWidth).toBe(SIDEBAR_WIDTH.min));
  });

  it("leaves keys that are not its own to whatever else wants them", async () => {
    const { store } = await mountShell();
    const event = fireEvent.keyDown(handle(), { key: "ArrowDown" });
    expect(event).toBe(true); // not consumed
    expect(store.getState().sidebarWidth).toBe(SIDEBAR_WIDTH.default);
  });

  it("says what it is and where it stands, and moves with its value", async () => {
    const { store } = await mountShell({ settings: { [KEY]: 320 } });
    expect(handle()).toHaveAttribute("aria-orientation", "vertical");
    expect(handle()).toHaveAttribute("aria-valuenow", "320");
    expect(handle()).toHaveAttribute("aria-valuemin", String(SIDEBAR_WIDTH.min));
    expect(handle()).toHaveAttribute("aria-valuemax", String(SIDEBAR_WIDTH.max));
    // It names the thing it resizes, which is the only reason a reader knows which edge this is.
    expect(handle()).toHaveAttribute("aria-controls", "app-sidebar");
    expect(document.getElementById("app-sidebar")).toHaveClass("sidebar");
    fireEvent.keyDown(handle(), { key: "End" });
    await waitFor(() => expect(handle()).toHaveAttribute("aria-valuenow", String(SIDEBAR_WIDTH.max)));
    expect(store.getState().sidebarWidth).toBe(SIDEBAR_WIDTH.max);
  });

  it("double-click puts the column back to the width Realm ships", async () => {
    const { store } = await mountShell({ settings: { [KEY]: 400 } });
    fireEvent.doubleClick(handle());
    await waitFor(() => expect(store.getState().sidebarWidth).toBe(SIDEBAR_WIDTH.default));
  });

  it("holds the cursor across the window for the length of the drag, and lets it go after", async () => {
    // Every pane the pointer crosses has a cursor of its own, and the drag spends most of its life
    // over them. THE leaked-attribute mutant: never remove it, and the app wears a resize cursor
    // for the rest of the session.
    await mountShell();
    pointer("pointerdown", 300);
    expect(document.documentElement).toHaveAttribute("data-sidebar-resizing");
    expect(handle()).toHaveAttribute("data-resizing");
    pointer("pointerup", 300);
    expect(document.documentElement).not.toHaveAttribute("data-sidebar-resizing");
    expect(handle()).not.toHaveAttribute("data-resizing");
  });

  it("lets go when the gesture is cancelled, keeping the width already on screen", async () => {
    // A cancel arrives when the OS takes the pointer away mid-drag. The column is already at the
    // width the drag reached, so the store has to be told about it — otherwise the next render of
    // the shell snaps it back to a number nobody has seen since the gesture began.
    const { store } = await mountShell();
    pointer("pointerdown", 300);
    pointer("pointermove", 350);
    pointer("pointercancel", 350);
    expect(document.documentElement).not.toHaveAttribute("data-sidebar-resizing");
    await waitFor(() => expect(store.getState().sidebarWidth).toBe(330));
    expect(painted()).toBe("330px");
  });

  it("is out of reach while the column is collapsed", async () => {
    // The handle lives inside the sidebar so that `inert` covers it: an off-screen column must not
    // be resizable by a keyboard that cannot see where it went.
    const { store } = await mountShell({ settings: { "ui.sidebarCollapsed": true } });
    expect(store.getState().sidebarCollapsed).toBe(true);
    expect(document.getElementById("app-sidebar")).toHaveAttribute("inert");
    expect(document.querySelector(".sb-resize")!.closest("[inert]")).not.toBeNull();
  });
});
