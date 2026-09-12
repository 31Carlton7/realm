import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TerminalHub, setTerminalHubForTests, type HubTransport, type TerminalLike } from "../terminal-hub";
import { DOCK_W_TERMINAL, dockPinMinPane } from "./pane-dock";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, session } from "../../state/store.test-fakes";
import { SessionPane, SessionPanelActions } from "./SessionPane";
import { reduceAll } from "./transcript-model";

/**
 * The terminal on the pane's right-hand strip, replacing the internal split it used to open as.
 *
 * The behaviours worth pinning are the ones the split did NOT have: it is one strip, so opening the
 * terminal puts the summary away; it obeys the dock's pin/float rule; and — the one that would be a
 * regression rather than a change — closing it must not take the shell with it.
 */
const ITEMS = { s1: [item("i9", "s1", { kind: "session", title: "Shell", refId: "se1" })] };
const SESSIONS = [session("se1", "s1", { title: "Shell" })];

/* The suite's own stand-in for xterm, which measures a canvas jsdom has no 2D context for. Borrowed
   from `session-pane.test.tsx` rather than mocking the module: a real `TerminalView` over a fake hub
   is what the rest of the terminal suite renders, and a second mocking style for the same component
   would be two answers to one question. */
function fakeHub() {
  const transport: HubTransport = { on: () => () => {}, call: async () => ({ ok: true }) };
  const term: TerminalLike = {
    cols: 80, rows: 24, open: () => {}, write: () => {}, dispose: () => {}, focus: () => {},
    onData: () => ({ dispose() {} }), onResize: () => ({ dispose() {} }),
  };
  return new TerminalHub(transport, () => ({ term, fit: { fit() {} } }));
}

async function mount() {
  setTerminalHubForTests(fakeHub());
  const api = fakeApi({ items: ITEMS, sessions: SESSIONS });
  const store = createAppStore(api);
  await store.getState().boot();
  store.setState({ sessionStatus: { se1: "idle" }, transcripts: { se1: { lastSeq: 0, t: reduceAll([]) } } });
  await store.getState().openItem("i9");
  const r = render(
    <StoreContext.Provider value={store}>
      <SessionPanelActions item={ITEMS.s1[0]!} keep={Number.POSITIVE_INFINITY} />
      <SessionPane item={ITEMS.s1[0]!} visible />
    </StoreContext.Provider>,
  );
  return { store, api, ...r };
}

const toggle = () => screen.getByRole("button", { name: /terminal for Shell/i });
const dock = () => screen.queryByRole("dialog", { name: /Terminal for/ });

/** A pane wide enough for the TERMINAL's dock — which is a different number from the summary's, and
 *  that difference is the point of `dockPinMinPane`. */
function withWidePane(run: () => Promise<void>) {
  const real = HTMLElement.prototype.getBoundingClientRect;
  const wide = dockPinMinPane(DOCK_W_TERMINAL) + 50;
  HTMLElement.prototype.getBoundingClientRect = function () {
    return this.classList.contains("session-pane")
      ? ({ x: 0, y: 0, top: 0, left: 0, right: wide, bottom: 800, width: wide, height: 800, toJSON: () => ({}) } as DOMRect)
      : real.call(this);
  };
  return run().finally(() => { HTMLElement.prototype.getBoundingClientRect = real; });
}

beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} }); });
afterEach(() => { cleanup(); setTerminalHubForTests(null); vi.unstubAllGlobals(); });

describe("the terminal dock", () => {
  it("opens as a dialog on the strip rather than splitting the pane", async () => {
    await mount();
    expect(dock()).toBeNull();
    fireEvent.click(toggle());
    await waitFor(() => expect(dock()).not.toBeNull());
    // The split's own machinery must be gone, not merely unused: a resize handle still in the tree
    // would mean the divider the whole change was about is still being drawn.
    expect(document.querySelector(".session-split")).toBeNull();
    expect(document.querySelector(".resize-handle")).toBeNull();
    // And the shell is INSIDE the dialog, not left somewhere else in the pane.
    await waitFor(() => expect(dock()!.querySelector(".terminal-pane")).not.toBeNull());
  });

  it("is a toggle, and says so to a reader who cannot see it", async () => {
    await mount();
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle());
    await waitFor(() => expect(toggle()).toHaveAttribute("aria-expanded", "true"));
    fireEvent.click(toggle());
    await waitFor(() => expect(dock()).toBeNull());
  });

  /* One strip, one occupant. Two panels measuring and claiming the same edge is the exact failure
   * `pane-dock.ts` exists to prevent, and the terminal joining the union is what extends that rule
   * to it rather than letting it draw over whatever was already there. */
  it("takes the strip from the summary, and gives it back", async () => {
    const { store } = await mount();
    store.getState().toggleSessionDock("se1", { kind: "summary" });
    await waitFor(() => expect(store.getState().sessionDock.se1).toEqual({ kind: "summary" }));

    fireEvent.click(toggle());
    await waitFor(() => expect(store.getState().sessionDock.se1).toEqual({ kind: "terminal" }));
    expect(screen.queryByRole("dialog", { name: /Session summary/ })).toBeNull();
  });

  it("starts the session's shell when it opens, and asks for it only once", async () => {
    const { api } = await mount();
    fireEvent.click(toggle());
    await waitFor(() => expect(api.calls.filter((c) => c.startsWith("openSessionTerminal"))).toHaveLength(1));
  });

  /* The regression this change could most easily introduce. A dock is a thing you dismiss, and if
   * dismissing it killed the pty then every ⌘J would cost the user their shell and its scrollback. */
  it("closing it keeps the shell — the pty is not the panel", async () => {
    const { store, api } = await mount();
    fireEvent.click(toggle());
    await waitFor(() => expect(store.getState().sessionTerminals.se1).toBeTruthy());
    const terminalId = store.getState().sessionTerminals.se1;

    fireEvent.click(toggle());
    await waitFor(() => expect(dock()).toBeNull());

    expect(store.getState().sessionTerminals.se1).toBe(terminalId);
    expect(api.disposed).not.toContain(terminalId);
    // And re-opening returns to the same shell rather than starting a second one.
    fireEvent.click(toggle());
    await waitFor(() => expect(dock()).not.toBeNull());
    expect(store.getState().sessionTerminals.se1).toBe(terminalId);
    expect(api.calls.filter((c) => c.startsWith("openSessionTerminal"))).toHaveLength(1);
  });

  it("pins beside the transcript when the pane can spare its width, and the pane makes room", async () => {
    await withWidePane(async () => {
      await mount();
      fireEvent.click(toggle());
      await waitFor(() => expect(dock()).not.toBeNull());
      expect(dock()).toHaveAttribute("data-pinned");
      const pane = document.querySelector<HTMLElement>(".session-pane");
      expect(pane).toHaveAttribute("data-dock-pinned");
      // The width travels with the attribute, or the pane would make room for the wrong panel — it
      // reads its sibling's size through this property and has no other route to it.
      expect(pane?.style.getPropertyValue("--dock-w")).toBe("var(--terminal-dock-w)");
      // Pinned, it stays put: reading a shell while scrolling the transcript is the whole point.
      fireEvent.mouseDown(document.body);
      expect(dock()).not.toBeNull();
    });
  });

  it("floats in a narrow pane, where a click outside dismisses it", async () => {
    // jsdom's zero rects ARE the narrow case, so this needs no stub.
    await mount();
    fireEvent.click(toggle());
    await waitFor(() => expect(dock()).not.toBeNull());
    expect(dock()).not.toHaveAttribute("data-pinned");
    expect(document.querySelector(".session-pane")).not.toHaveAttribute("data-dock-pinned");
    fireEvent.mouseDown(document.body);
    await waitFor(() => expect(dock()).toBeNull());
  });

  it("gives the pane its width back when the dock closes", async () => {
    await withWidePane(async () => {
      await mount();
      fireEvent.click(toggle());
      await waitFor(() => expect(document.querySelector(".session-pane")).toHaveAttribute("data-dock-pinned"));
      fireEvent.click(toggle());
      await waitFor(() => expect(dock()).toBeNull());
      const pane = document.querySelector<HTMLElement>(".session-pane");
      expect(pane).not.toHaveAttribute("data-dock-pinned");
      expect(pane?.style.getPropertyValue("--dock-w")).toBe("");
    });
  });

  it("Escape closes it even while pinned", async () => {
    await withWidePane(async () => {
      await mount();
      fireEvent.click(toggle());
      await waitFor(() => expect(dock()).toHaveAttribute("data-pinned"));
      fireEvent.keyDown(window, { key: "Escape" });
      await waitFor(() => expect(dock()).toBeNull());
    });
  });
});

describe("the terminal dock's pin threshold", () => {
  /* The summary and the terminal are no longer one width, so one constant cannot decide both: a pane
   * that comfortably pins a 320px summary would be left with a ~200px transcript by a 560px shell. */
  it("asks more of the pane than the summary's does", () => {
    expect(dockPinMinPane(DOCK_W_TERMINAL)).toBeGreaterThan(dockPinMinPane(320));
    expect(dockPinMinPane(DOCK_W_TERMINAL) - DOCK_W_TERMINAL).toBe(dockPinMinPane(320) - 320);
  });
});
