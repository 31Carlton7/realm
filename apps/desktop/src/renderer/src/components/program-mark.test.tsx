import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { findSidePane, TERMINAL_PROGRAM_MARKS, type TerminalProgram } from "@realm/contracts";
import { isIconName } from "@realm/ui";
import { PaneHost } from "./PaneHost";
import { ProgramMark, TerminalMark } from "./ProgramMark";
import { StoreContext, createAppStore } from "../state/store";
import { fakeApi, item, session } from "../state/store.test-fakes";
import { TerminalHub, setTerminalHubForTests, type HubTransport, type TerminalLike } from "../panes/terminal-hub";
import { setBrowserBridgesForTests } from "../panes/browser/browser-client";
import { fakeBrowserBridges } from "../panes/browser/browser-bridges.test-fakes";

const claude: TerminalProgram = { id: "claude", label: "claude", mark: "claude", agent: true };
const fx: TerminalProgram = { id: "fx", label: "fx", mark: "fx", agent: true };
const python: TerminalProgram = { id: "python", label: "python3", mark: "python", agent: false };

/** A hub whose server says what each terminal runs, and can say it again. */
function fakeHub(programs: Record<string, TerminalProgram> = {}) {
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  const transport: HubTransport = {
    on: (event, fn) => { const s = listeners.get(event) ?? new Set(); s.add(fn as (p: unknown) => void); listeners.set(event, s); return () => s.delete(fn as (p: unknown) => void); },
    call: async (method) => (method === "terminals.programs" ? { ...programs }
      : method === "terminals.read" ? { runId: "r1", seq: 0, live: "", truncated: false, running: true, history: null } : { ok: true }),
  };
  const term: TerminalLike = {
    cols: 80, rows: 24, open: () => {}, write: () => {}, dispose: () => {}, focus: () => {},
    onData: () => ({ dispose() {} }), onResize: () => ({ dispose() {} }),
  };
  const hub = new TerminalHub(transport, () => ({ term, fit: { fit() {} } }));
  const say = (terminalId: string, program: TerminalProgram | null) =>
    act(() => { for (const fn of listeners.get("terminal.program") ?? []) fn({ terminalId, program }); });
  return { hub, say };
}
const settled = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
/** The slot of a terminal's mark that is showing — both stay stacked, `.icon-swap`'s way. */
const shown = (within: Element) => {
  const box = within.matches(".program-mark") ? within : within.querySelector(".program-mark")!;
  return box.querySelector(box.hasAttribute("data-on") ? ":scope > .swap-on" : ":scope > .swap-off")!;
};

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  setBrowserBridgesForTests(fakeBrowserBridges());
});
afterEach(() => { cleanup(); setTerminalHubForTests(null); setBrowserBridgesForTests(null); vi.unstubAllGlobals(); });

describe("a program's mark", () => {
  it("resolves to a glyph for every mark the table can name — none falls through to the folder", () => {
    // `Icon` draws a folder for a name it does not hold, silently. THE mutant: a program added to the
    // table under a mark the icon set never got.
    expect(TERMINAL_PROGRAM_MARKS.filter((m) => !isIconName(m))).toEqual([]);
  });

  it("puts an agent on a tile in its vendor's colour, or near-black where the vendor names none", () => {
    const { container } = render(<><ProgramMark program={claude} size={14} /><ProgramMark program={fx} size={14} /></>);
    const [coral, ink] = container.querySelectorAll<HTMLElement>(".program-tile");
    expect(coral!.style.getPropertyValue("--program-tile")).toBe("#D97757");
    expect(coral!.querySelector("[data-brand='claude']")).not.toBeNull();
    expect(ink).toHaveAttribute("data-ink");
    expect(ink!.querySelector("[data-brand='fx']")).not.toBeNull();
  });

  it("gives a tool its bare glyph and the shell the terminal glyph, with no tile for either", () => {
    const { container } = render(<><ProgramMark program={python} size={14} /><ProgramMark program={null} size={14} /></>);
    expect(container.querySelector(".program-tile")).toBeNull();
    expect(container.querySelectorAll("svg")).toHaveLength(2);
  });

  it("takes the same square whatever it shows, so a program starting never moves the title", () => {
    const { hub, say } = fakeHub();
    setTerminalHubForTests(hub);
    const { container } = render(<TerminalMark terminalId="t1" size={14} />);
    const box = container.querySelector<HTMLElement>(".program-mark")!;
    const square = () => [box.style.width, box.style.height];
    expect(square()).toEqual(["14px", "14px"]);
    say("t1", claude);
    expect(square()).toEqual(["14px", "14px"]);
    expect(box.querySelector<HTMLElement>(".program-tile")!.style.width).toBe("14px");
  });

  it("turns over on the app's one icon swap when the program changes — never on first draw", async () => {
    // A tab that opens onto a running agent shows it; it does not announce it. THE mutant: arm the
    // swap before the hub's first read has landed, and every tab mounted with a running agent turns
    // over as though the agent had just started.
    const { hub, say } = fakeHub({ t1: claude });
    setTerminalHubForTests(hub);
    const { container } = render(<TerminalMark terminalId="t1" size={14} />);
    await settled();
    const box = container.querySelector(".program-mark")!;
    expect(box).toHaveClass("icon-swap");
    expect(box).not.toHaveAttribute("data-on");
    expect(shown(box).querySelector(".program-tile")).not.toBeNull();
    say("t1", null);
    expect(box).toHaveAttribute("data-on");
    expect(shown(box).querySelector(".program-tile")).toBeNull();
    say("t1", claude); // and back: it turns over the other way
    expect(box).not.toHaveAttribute("data-on");
    expect(shown(box).querySelector("[data-brand='claude']")).not.toBeNull();
  });
});

describe("a terminal's tab", () => {
  const ITEMS = [
    item("i-lead", "s1", { kind: "session", refId: "lead", title: "Lead" }),
    item("i-term", "s1", { kind: "terminal", refId: "t1", title: "realm" }),
    item("i-br", "s1", { kind: "browser", refId: "br", title: "Docs" }),
  ];

  async function mount(programs: Record<string, TerminalProgram>) {
    const fake = fakeHub(programs);
    setTerminalHubForTests(fake.hub);
    const store = createAppStore(fakeApi({ items: { s1: [...ITEMS] }, sessions: [session("lead", "s1")] }));
    await store.getState().boot();
    await store.getState().openItem("i-lead");
    await store.getState().openInSidePane("lead", "i-term");
    await store.getState().openInSidePane("lead", "i-br");
    await store.getState().openItem("i-br", findSidePane(store.getState().layout!, "i-lead")!.id);
    render(
      <StoreContext.Provider value={store}>
        <PaneHost layout={store.getState().layout!} items={store.getState().items} focusedLeafId={store.getState().focusedLeafId}
          onFocus={() => {}} onClose={() => {}} onSplit={() => {}} />
      </StoreContext.Provider>,
    );
    await settled();
    return fake;
  }
  const tab = (name: RegExp) => within(screen.getByRole("tablist", { name: "Tabs" })).getByRole("tab", { name });

  it("says what is running before its folder, even while another tab is showing", async () => {
    // The tab NOT on screen is exactly where "the agent in the other terminal" has to be said.
    const { say } = await mount({ t1: claude });
    expect(tab(/realm/)).toHaveTextContent("claude · realm");
    expect(tab(/realm/)).toHaveAttribute("title", "claude · realm");
    expect(shown(tab(/realm/)).querySelector(".program-tile [data-brand='claude']")).not.toBeNull();
    say("t1", null);
    expect(tab(/realm/)).toHaveTextContent(/^realm$/);
    expect(shown(tab(/realm/)).querySelector(".program-tile")).toBeNull();
    // Another kind's tab is untouched by any of it.
    expect(tab(/Docs/)).toHaveTextContent(/^Docs$/);
  });
});
