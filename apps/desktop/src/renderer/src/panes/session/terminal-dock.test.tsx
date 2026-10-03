import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { findLeafOfItem, findSidePane } from "@realm/contracts";
import { TerminalHub, setTerminalHubForTests, type HubTransport, type TerminalLike } from "../terminal-hub";
import { DOCK_H_TERMINAL, dockPinMinPaneHeight } from "./pane-dock";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, session } from "../../state/store.test-fakes";
import { SessionPane, SessionPanelActions } from "./SessionPane";
import { reduceAll } from "./transcript-model";

/**
 * The session's terminal from the pane bar's button.
 *
 * In its default place it is a tab of the session's side pane — the pane the browsers, documents and
 * devices its agents open go to — and the button is a plain action that goes there, as the bar's
 * other side-pane buttons do. Settings can dock it to the pane's foot instead, and there it is still
 * the card it was: a toggle, pinned or floating by the pane's height, and closing it keeps the shell.
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

async function mount(opts: { bottom?: boolean } = {}) {
  setTerminalHubForTests(fakeHub());
  const api = fakeApi({ items: ITEMS, sessions: SESSIONS });
  const store = createAppStore(api);
  await store.getState().boot();
  store.setState({ sessionStatus: { se1: "idle" }, transcripts: { se1: { lastSeq: 0, t: reduceAll([]) } },
    ...(opts.bottom ? { terminalDock: "bottom" as const } : {}) });
  await store.getState().openItem("i9");
  const r = render(
    <StoreContext.Provider value={store}>
      <SessionPanelActions item={ITEMS.s1[0]!} keep={Number.POSITIVE_INFINITY} />
      <SessionPane item={ITEMS.s1[0]!} visible />
    </StoreContext.Provider>,
  );
  return { store, api, ...r };
}

const button = () => screen.getByRole("button", { name: /terminal (for|beside) Shell/i });
const dock = () => screen.queryByRole("dialog", { name: /Terminal for/ });

beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} }); });
afterEach(() => { cleanup(); setTerminalHubForTests(null); vi.unstubAllGlobals(); });

describe("the terminal button, in the terminal's default place", () => {
  it("opens the terminal as a tab of the session's side pane, not as a panel over the transcript", async () => {
    // THE MUTANT: the button toggling the dock as it used to — a card hanging over the transcript.
    const { store, api } = await mount();
    fireEvent.click(button());
    await waitFor(() => expect(findSidePane(store.getState().layout!, "i9")?.tabs).toHaveLength(1));
    const tab = findSidePane(store.getState().layout!, "i9")!;
    expect(store.getState().items.find((i) => i.id === tab.itemId)?.kind).toBe("terminal");
    expect(store.getState().focusedLeafId).toBe(tab.id);
    expect(api.calls).toContain("createTerminal:s1:/tmp");
    expect(dock()).toBeNull();
    expect(store.getState().sessionDock.se1).toBeUndefined();
  });

  it("is a plain action like the side-pane buttons beside it — no pressed state, no dialog", async () => {
    // A toggle's state would be a claim the button cannot keep: a second press goes to the tab rather
    // than putting it away, which is what Documents and Browser do with theirs.
    await mount();
    expect(button()).toHaveAccessibleName("Open the terminal beside Shell");
    expect(button()).not.toHaveAttribute("aria-pressed");
    expect(button()).not.toHaveAttribute("aria-haspopup");
  });

  it("goes back to the same tab on a second press", async () => {
    const { store, api } = await mount();
    fireEvent.click(button());
    await waitFor(() => expect(findSidePane(store.getState().layout!, "i9")).not.toBeNull());
    store.getState().focusLeaf(findLeafOfItem(store.getState().layout!, "i9")!.id);
    fireEvent.click(button());
    await waitFor(() => expect(store.getState().focusedLeafId).toBe(findSidePane(store.getState().layout!, "i9")!.id));
    expect(api.calls.filter((c) => c.startsWith("createTerminal"))).toHaveLength(1);
    expect(findSidePane(store.getState().layout!, "i9")!.tabs).toHaveLength(1);
  });

  it("draws no dock left open from the bottom placement once the setting moves back", async () => {
    // THE MUTANT: render the dock off `sessionDock` alone, and a dock opened under Bottom stays drawn —
    // at the foot — after Settings has said the terminal lives in a tab.
    const { store } = await mount({ bottom: true });
    fireEvent.click(button());
    await waitFor(() => expect(dock()).not.toBeNull());
    act(() => store.setState({ terminalDock: "right" }));
    await waitFor(() => expect(dock()).toBeNull());
  });
});

/** A pane of a given height and a width too narrow for the right-hand strip, so a pin can only be
 *  the bottom edge's doing. */
function withPane(height: number, run: () => Promise<void>) {
  const real = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function () {
    return this.classList.contains("session-pane")
      ? ({ x: 40, y: 0, top: 0, left: 40, right: 640, bottom: height, width: 600, height, toJSON: () => ({}) } as DOMRect)
      : real.call(this);
  };
  return run().finally(() => { HTMLElement.prototype.getBoundingClientRect = real; });
}
const TALL = dockPinMinPaneHeight(DOCK_H_TERMINAL) + 40;

describe("the terminal docked to the bottom (Settings ▸ General ▸ Terminals)", () => {
  const bottom = () => mount({ bottom: true });

  it("opens as a dialog along the pane's foot rather than splitting the pane or making a tab", async () => {
    const { store } = await bottom();
    expect(dock()).toBeNull();
    fireEvent.click(button());
    await waitFor(() => expect(dock()).not.toBeNull());
    // The split's own machinery must be gone, not merely unused: a resize handle still in the tree
    // would mean the divider the dock replaced is still being drawn.
    expect(document.querySelector(".session-split")).toBeNull();
    expect(document.querySelector(".resize-handle")).toBeNull();
    // And the shell is INSIDE the dialog, not left somewhere else in the pane — or in a tab.
    await waitFor(() => expect(dock()!.querySelector(".terminal-pane")).not.toBeNull());
    expect(findSidePane(store.getState().layout!, "i9")).toBeNull();
  });

  it("is a toggle, and says so to a reader who cannot see it", async () => {
    await bottom();
    expect(button()).toHaveAccessibleName("Show terminal for Shell");
    expect(button()).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(button());
    await waitFor(() => expect(button()).toHaveAttribute("aria-expanded", "true"));
    fireEvent.click(button());
    await waitFor(() => expect(dock()).toBeNull());
  });

  /* One slot, one occupant. Two panels claiming the pane's dock at once is the failure `sessionDock`
   * exists to prevent, so opening the terminal puts the summary away. */
  it("takes the slot from the summary", async () => {
    const { store } = await bottom();
    store.getState().toggleSessionDock("se1", { kind: "summary" });
    await waitFor(() => expect(store.getState().sessionDock.se1).toEqual({ kind: "summary" }));

    fireEvent.click(button());
    await waitFor(() => expect(store.getState().sessionDock.se1).toEqual({ kind: "terminal" }));
    expect(screen.queryByRole("dialog", { name: /Session summary/ })).toBeNull();
  });

  it("starts the session's shell when it opens, and asks for it only once", async () => {
    const { api } = await bottom();
    fireEvent.click(button());
    await waitFor(() => expect(api.calls.filter((c) => c.startsWith("openSessionTerminal"))).toHaveLength(1));
  });

  /* The regression a dock could most easily introduce. A dock is a thing you dismiss, and if
   * dismissing it killed the pty then every ⌘J would cost the user their shell and its scrollback. */
  it("closing it keeps the shell — the pty is not the panel", async () => {
    const { store, api } = await bottom();
    fireEvent.click(button());
    await waitFor(() => expect(store.getState().sessionTerminals.se1).toBeTruthy());
    const terminalId = store.getState().sessionTerminals.se1;

    fireEvent.click(button());
    await waitFor(() => expect(dock()).toBeNull());

    expect(store.getState().sessionTerminals.se1).toBe(terminalId);
    expect(api.disposed).not.toContain(terminalId);
    // And re-opening returns to the same shell rather than starting a second one.
    fireEvent.click(button());
    await waitFor(() => expect(dock()).not.toBeNull());
    expect(store.getState().sessionTerminals.se1).toBe(terminalId);
    expect(api.calls.filter((c) => c.startsWith("openSessionTerminal"))).toHaveLength(1);
  });

  it("sits along the pane's foot and, in a tall pane, takes the pane's height rather than its width", async () => {
    await withPane(TALL, async () => {
      await bottom();
      fireEvent.click(button());
      await waitFor(() => expect(dock()).not.toBeNull());
      expect(dock()).toHaveAttribute("data-pinned");
      // Anchored to the pane's left edge and foot, not to its right side.
      expect(dock()!.style.left).toBe("40px");
      expect(dock()!.style.top).toBe("");
      const pane = document.querySelector<HTMLElement>(".session-pane")!;
      // THE right-strip mutant: reserve the strip anyway, and the transcript loses a column to a
      // dock that is not in it.
      expect(pane).toHaveAttribute("data-dock-bottom");
      expect(pane).not.toHaveAttribute("data-dock-pinned");
      expect(pane.style.getPropertyValue("--dock-h")).toBe("var(--terminal-dock-h)");
      // Pinned, it stays put: reading a shell while scrolling the transcript is the whole point.
      fireEvent.mouseDown(document.body);
      expect(dock()).not.toBeNull();
    });
  });

  it("floats over the foot of a short pane, which keeps its height, and a click outside dismisses it", async () => {
    await withPane(dockPinMinPaneHeight(DOCK_H_TERMINAL) - 40, async () => {
      await bottom();
      fireEvent.click(button());
      await waitFor(() => expect(dock()).not.toBeNull());
      expect(dock()).not.toHaveAttribute("data-pinned");
      expect(document.querySelector(".session-pane")).not.toHaveAttribute("data-dock-bottom");
      fireEvent.mouseDown(document.body);
      await waitFor(() => expect(dock()).toBeNull());
    });
  });

  it("gives the height back when it closes, and the shell stays", async () => {
    await withPane(TALL, async () => {
      const { store } = await bottom();
      fireEvent.click(button());
      await waitFor(() => expect(document.querySelector(".session-pane")).toHaveAttribute("data-dock-bottom"));
      const shell = store.getState().sessionTerminals.se1;
      fireEvent.click(button());
      await waitFor(() => expect(dock()).toBeNull());
      const pane = document.querySelector<HTMLElement>(".session-pane")!;
      expect(pane).not.toHaveAttribute("data-dock-bottom");
      expect(pane.style.getPropertyValue("--dock-h")).toBe("");
      expect(store.getState().sessionTerminals.se1).toBe(shell);
    });
  });

  it("Escape closes it even while pinned", async () => {
    await withPane(TALL, async () => {
      await bottom();
      fireEvent.click(button());
      await waitFor(() => expect(dock()).toHaveAttribute("data-pinned"));
      fireEvent.keyDown(window, { key: "Escape" });
      await waitFor(() => expect(dock()).toBeNull());
    });
  });
});
