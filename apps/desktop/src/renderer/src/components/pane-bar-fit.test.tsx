import { afterEach, describe, expect, it } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import type { Environment } from "@realm/contracts";
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

async function mountAt(width: number) {
  observed = [];
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver;
  const api = fakeApi({
    sessions: [session("se1", "s1", { status: "idle", environmentId: ENV.id, cwd: ENV.path })],
    environments: { s1: [ENV] },
  });
  const store = createAppStore(api);
  await store.getState().boot();
  /* An empty transcript, so the list here is the five UNCONDITIONAL actions: terminal, documents,
     browser, machine, simulator. The summary is a sixth in front of them when the session has
     anything to report, and its gate is tested where the gate lives (session-summary-panel.test.tsx)
     — leaving it out here keeps every count below a fact about the budget rather than about a
     summariser's opinion of a fixture. */
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

  it("puts an action in the bar or in the menu, and never in both", async () => {
    /* The duplicate is what this design exists to avoid: `@container` could hide these buttons but
       could not tell the menu which ones it had hidden, so the menu would have to carry all six at
       every width. THE mutant: list them in the menu unconditionally. */
    await mountAt(widthFor(2));
    expect(barActions()).toHaveLength(2);
    expect(barActions().some((n) => /terminal/.test(n))).toBe(true);
    expect(barActions().some((n) => /documents/.test(n))).toBe(true);
    openMenu();
    expect(menuRows()).toEqual(expect.arrayContaining(["Browser", "Machine", "Simulator"]));
    for (const stillInTheBar of ["Terminal", "Documents"]) expect(menuRows()).not.toContain(stillInTheBar);
  });

  it("gives them up from the END, so what a session IS outlasts the panes it opens beside itself", async () => {
    /* Order is priority. The summary is the only place a session's outputs and spend are listed and
       the terminal is its own shell; the ones after them open a pane BESIDE it and are each reachable
       from the sidebar and the palette too. THE mutant: slice from the front, and a one-action bar
       offers a simulator while the session's own terminal is buried. */
    await mountAt(widthFor(1));
    expect(barActions()).toHaveLength(1);
    expect(barActions()[0]).toMatch(/terminal/);
    openMenu();
    expect(menuRows()).toEqual(expect.arrayContaining(["Documents", "Browser", "Machine", "Simulator"]));
    expect(menuRows()).not.toContain("Terminal");
  });

  it("keeps every button in a wide bar, and adds no rows to the menu for them", async () => {
    await mountAt(widthFor(9));
    expect(barActions()).toHaveLength(5);
    openMenu();
    // The layout rows are still there; the action rows are not, because none of them left the bar.
    expect(menuRows()).toEqual(expect.arrayContaining(["Rename", "Split right", "Close"]));
    for (const gone of ["Browser", "Machine", "Simulator", "Terminal", "Documents"]) expect(menuRows()).not.toContain(gone);
  });

  it("an overflowed toggle still says which way it is pointing", async () => {
    /* THE mutant: drop `checked` from the row. A toggle that has moved into the menu stops saying
       whether it is on — and unlike a button, a menu row has no fill to say it with. */
    await mountAt(widthFor(0));
    openMenu();
    // A checkbox ROW, not a plain one — that is what carries the state into the menu at all.
    const row = () => {
      const rows = screen.getAllByRole("menuitemcheckbox");
      expect(rows.map((r) => r.textContent)).toEqual(["Terminal"]);
      return rows[0]!;
    };
    expect(row()).toHaveAttribute("aria-checked", "false");
    fireEvent.click(row());
    // The menu spends a beat fading, `inert` and out of the a11y tree, before it is gone — reopening
    // into that beat finds the closing copy rather than a fresh one.
    await exited();
    openMenu();
    expect(row()).toHaveAttribute("aria-checked", "true");
  });
});
