import { afterEach, describe, expect, it } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { TERMINALS_DOCK_KEY, type Environment } from "@realm/contracts";
import { PanelBar } from "./PanelBar";
import { ACTION_W, BAR_CHROME, TITLE_MIN, actionsThatFit } from "./pane-bar-fit";
import { StoreContext, createAppStore } from "../state/store";
import { fakeApi, item, session } from "../state/store.test-fakes";
import { reduceAll } from "../panes/session/transcript-model";
import { exited } from "./popover-exit.test-fakes";

/**
 * A narrow pane bar gives its actions up to the ⋯ menu, one at a time.
 *
 * Split in two on purpose. `actionsThatFit` is arithmetic and is tested as arithmetic — jsdom has no
 * layout, so a test that rendered a bar and asked how wide it was would be reading a zero. What the
 * rendering tests check instead is the WIRING: that one budget reaches both halves of the cluster,
 * and that an action is therefore in exactly one of them.
 */
const ITEM = item("i1", "s1", { kind: "session", refId: "se1", title: "A session" });
const ENV: Environment = { id: "env1", spaceId: "s1", path: "/tmp/wt", branch: "main",
  kind: "worktree", portBlockStart: 41020, createdAt: 0, updatedAt: 0 };

/* jsdom ships no ResizeObserver, so the hook's real path is unreachable without one. This is the
   smallest thing that IS one: it records what was observed and hands back the width the test is
   about, which is the only input `useActionBudget` has. */
let observed: ResizeObserverCallback[] = [];
class FakeResizeObserver {
  constructor(private cb: ResizeObserverCallback) {}
  observe() { observed.push(this.cb); }
  disconnect() {}
  unobserve() {}
}
afterEach(() => { observed = []; delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver; });

async function mountAt(width: number, settings: Record<string, unknown> = {}) {
  observed = [];
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver;
  const api = fakeApi({
    sessions: [session("se1", "s1", { status: "idle", environmentId: ENV.id, cwd: ENV.path })],
    environments: { s1: [ENV] },
    settings,
  });
  const store = createAppStore(api);
  await store.getState().boot();
  /* An empty transcript: the session's actions are the summary-and-files dock, which is offered
     whatever the transcript holds, and the terminal where Settings docks it at the pane's foot. What
     the dock opens on is tested where that is decided (session-summary-panel.test.tsx). */
  store.setState({ transcripts: { se1: { lastSeq: 0, t: reduceAll([]) } } });
  const view = render(
    <StoreContext.Provider value={store}>
      <PanelBar item={ITEM} leafId="L1" onSplit={() => {}} onClose={() => {}} />
    </StoreContext.Provider>,
  );
  act(() => { for (const cb of observed) cb([{ contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver); });
  return { store, ...view };
}

/** The width at which exactly `n` actions fit, comfortably inside the rung. */
const widthFor = (n: number) => BAR_CHROME + TITLE_MIN + ACTION_W * n + 1;
const barActions = () =>
  [...document.querySelectorAll(".panel-actions button")]
    .map((b) => b.getAttribute("aria-label") ?? "")
    .filter((n) => !/^(Pane menu|Close|Delete|Really delete)/.test(n));
const menuRows = () => [...document.querySelectorAll('.menu [role^="menuitem"] .menu-label')].map((n) => n.textContent);
const openMenu = () => fireEvent.click(screen.getByRole("button", { name: /^Pane menu/ }));

describe("what a narrowing pane bar gives up", () => {
  it("spends width on actions only after the title has had enough", () => {
    /* THE mutant: drop `TITLE_MIN` from the sum. Every rung moves down by four actions and the bar
       goes back to what it was doing — six glyphs and a title squeezed to nothing, which in a split
       leaves two session panes that look identical. */
    expect(actionsThatFit(BAR_CHROME + TITLE_MIN)).toBe(0);
    expect(actionsThatFit(BAR_CHROME + TITLE_MIN + ACTION_W - 1)).toBe(0);
    // One action per rung, all the way up — "slowly", not a cliff from all to none.
    for (let n = 0; n <= 6; n++) expect(actionsThatFit(widthFor(n)), `${n}`).toBe(n);
    // Never negative: a bar narrower than its own furniture keeps ⋯ and ×, and gives up the rest.
    expect(actionsThatFit(40)).toBe(0);
  });

  it("treats an unmeasured bar as roomy, so nothing flickers into the menu on mount", () => {
    /* THE mutant: return 0 for a width of 0. Every pane in the app would draw its whole cluster into
       the ⋯ menu for the frame between mount and the first ResizeObserver callback, and a bar that
       fills itself in after a frame reads as the app arriving broken. */
    expect(actionsThatFit(0)).toBe(Number.POSITIVE_INFINITY);
  });

  /* A session's own actions are its panels — the dock of what it made, and the terminal where
     Settings docks it to the pane's foot — so the bottom placement is the one with two to ration, and
     the budget's wiring is shown on it. */
  const bottom = { [TERMINALS_DOCK_KEY]: "bottom" };

  it("puts an action in the bar or in the menu, and never in both — giving them up from the END", async () => {
    /* The duplicate is what this design exists to avoid: `@container` could hide these buttons but
       could not tell the menu which ones it had hidden, so the menu would have to carry all of them
       at every width. THE mutants: list them in the menu unconditionally, or slice from the front —
       and a one-action bar keeps the shell while what the session made is buried in a menu. */
    await mountAt(widthFor(1), bottom);
    expect(barActions()).toEqual(["Summary and files for A session"]);
    openMenu();
    expect(menuRows()).toContain("Terminal");
    expect(menuRows()).not.toContain("Summary and files");
  });

  it("keeps every button in a wide bar, adds no rows to the menu for them, and offers no close", async () => {
    await mountAt(widthFor(9), bottom);
    expect(barActions()).toHaveLength(2);
    openMenu();
    // The layout rows are still there; the action rows are not, because none of them left the bar.
    expect(menuRows()).toEqual(expect.arrayContaining(["Rename", "Split right", "Delete"]));
    for (const gone of ["Summary and files", "Terminal", "Close"]) expect(menuRows()).not.toContain(gone);
  });

  it("an overflowed toggle still says which way it is pointing", async () => {
    /* THE mutant: drop `checked` from the row. A toggle that has moved into the menu stops saying
       whether it is on — and unlike a button, a menu row has no fill to say it with.
       The terminal is a toggle only where Settings docks it at the pane's foot: elsewhere it opens a
       tab of the side pane, which has no "on" to show (the next test). */
    await mountAt(widthFor(0), bottom);
    openMenu();
    // A checkbox ROW, not a plain one — that is what carries the state into the menu at all.
    const row = () => {
      const rows = screen.getAllByRole("menuitemcheckbox");
      // Two toggles reach the menu: the summary-and-files dock and the terminal. The terminal is the
      // one whose NAME holds still, which is what `pressed` — and therefore this row — is about.
      expect(rows.map((r) => r.textContent)).toEqual(["Summary and files", "Terminal"]);
      return rows[1]!;
    };
    expect(row()).toHaveAttribute("aria-checked", "false");
    fireEvent.click(row());
    // The menu spends a beat fading, `inert` and out of the a11y tree, before it is gone — reopening
    // into that beat finds the closing copy rather than a fresh one.
    await exited();
    openMenu();
    expect(row()).toHaveAttribute("aria-checked", "true");
  });

  it("in its default place the terminal is not the bar's at all — the side pane launches it", async () => {
    // THE MUTANT: keep the terminal in the list whatever the setting. Its row would sit in the menu of
    // a bar that no longer carries the tools a session opens beside itself.
    await mountAt(widthFor(0));
    openMenu();
    expect(screen.getAllByRole("menuitemcheckbox").map((r) => r.textContent)).toEqual(["Summary and files"]);
    expect(screen.queryByRole("menuitem", { name: /Terminal/ })).toBeNull();
  });
});
