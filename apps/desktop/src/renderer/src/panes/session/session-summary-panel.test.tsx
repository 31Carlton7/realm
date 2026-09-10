import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createAppStore, StoreContext } from "../../state/store";
import { fakeApi, item } from "../../state/store.test-fakes";
import { reduceAll } from "./transcript-model";
import { sessionEvent } from "@realm/contracts";
import { SessionSummaryButton, SUMMARY_PIN_MIN_PANE, contextRows } from "./SessionSummary";
import { session as fakeSession } from "../../state/store.test-fakes";

afterEach(() => cleanup());

/** `sessionEvent` already stamps a `ts`; the reducer reads nothing else off the envelope, so the
 *  events go in exactly as the adapters emit them. */
type Event = ReturnType<typeof sessionEvent>;

async function mount(events: Event[]) {
  const api = fakeApi();
  const store = createAppStore(api);
  await store.getState().boot();
  store.setState({ transcripts: { se1: { lastSeq: 0, t: reduceAll(events) } } });
  const view = render(
    <StoreContext.Provider value={store}>
      <SessionSummaryButton item={item("i9", "s1", { kind: "session", refId: "se1", title: "A session" })} />
    </StoreContext.Provider>,
  );
  return { api, store, ...view };
}

const openPanel = () => fireEvent.click(screen.getByRole("button", { name: "Summary of A session" }));
const sectionNames = () => [...document.querySelectorAll(".summary-head")].map((h) => h.firstElementChild?.nextElementSibling?.textContent);
const rowNames = () => [...document.querySelectorAll(".summary-row-name")].map((n) => n.textContent);

describe("the session summary button", () => {
  it("is not drawn at all for a session that has produced, received and proposed nothing", async () => {
    // A permanently-empty panel behind a permanent button is the dead chrome the pane bar bans.
    await mount([(sessionEvent("user_message", { text: "hello", attachments: [] }))]);
    expect(screen.queryByRole("button", { name: /Summary/ })).toBeNull();
  });

  it("appears the moment the session has something to summarise", async () => {
    await mount([
      (sessionEvent("tool_call", { toolUseId: "t1", name: "Write", input: { file_path: "/a/made.ts" }, parentToolUseId: null })),
      (sessionEvent("tool_result", { toolUseId: "t1", content: "ok", isError: false })),
    ]);
    expect(screen.getByRole("button", { name: "Summary of A session" })).toBeInTheDocument();
  });

  it("lists outputs, uploads and plans under their own headings, and omits a section with nothing in it", async () => {
    await mount([
      (sessionEvent("user_message", { text: "look", attachments: [{ path: "/u/spec.pdf", mime: "application/pdf" }] })),
      (sessionEvent("tool_call", { toolUseId: "t1", name: "Write", input: { file_path: "/a/made.ts" }, parentToolUseId: null })),
      (sessionEvent("tool_result", { toolUseId: "t1", content: "ok", isError: false })),
    ]);
    openPanel();
    // No plan was proposed, so there is no Plans heading — not a "Plans 0".
    expect(sectionNames()).toEqual(["Outputs", "Sources"]);
    expect(rowNames()).toEqual(["made.ts", "spec.pdf"]);
  });

  it("a link the agent offered leaves for the OS browser rather than opening a viewer", async () => {
    await mount([(sessionEvent("assistant_text", { messageId: "m1", text: "Deployed to https://app.test/live" }))]);
    openPanel();
    const link = screen.getByRole("link", { name: /app.test/ });
    expect(link).toHaveAttribute("href", "https://app.test/live");
    // Without target=_blank the click would navigate the renderer itself out of the app.
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("a plan row opens the plan sheet, named by session and plan id rather than by a copy of the plan", async () => {
    // A copy in the sheet slot could go stale against the transcript it came from; the sheet re-reads.
    const { store } = await mount([
      (sessionEvent("plan", { planId: "p1", text: "# Rewrite the parser", steps: [{ text: "one", status: "pending" }] })),
    ]);
    openPanel();
    fireEvent.click(screen.getByRole("button", { name: /Rewrite the parser/ }));
    expect(store.getState().sheet).toEqual({ kind: "session-plan", sessionId: "se1", planId: "p1" });
  });

  it("a file the documents pane can show opens THERE, not in a modal about the Finder", async () => {
    /* The gap this closes: an agent writes six files, the summary lists them, and every one opened a
       sheet whose only real action was "leave for the Finder" — so the artifacts a session produced
       were the one thing you could not look at inside Realm. */
    const { api, store } = await mount([
      (sessionEvent("tool_call", { toolUseId: "t1", name: "Write", input: { file_path: "/a/report.md" }, parentToolUseId: null })),
      (sessionEvent("tool_result", { toolUseId: "t1", content: "ok", isError: false })),
    ]);
    openPanel();
    fireEvent.click(screen.getByRole("button", { name: /report.md/ }));
    await waitFor(() => expect(api.calls.some((c) => c.startsWith("openDocumentPath:"))).toBe(true));
    expect(store.getState().sheet).toBeNull();
  });

  it("…and one it has no view for still gets the sheet", async () => {
    // A `.zip`, a binary. The sheet is the honest answer there: naming the file and offering the OS.
    const { store } = await mount([
      (sessionEvent("tool_call", { toolUseId: "t1", name: "Write", input: { file_path: "/a/bundle.zip" }, parentToolUseId: null })),
      (sessionEvent("tool_result", { toolUseId: "t1", content: "ok", isError: false })),
    ]);
    openPanel();
    fireEvent.click(screen.getByRole("button", { name: /bundle.zip/ }));
    expect(store.getState().sheet).toEqual({ kind: "artifact", path: "/a/bundle.zip" });
  });
});

describe("the summary as a side panel", () => {
  it("stays open across clicks elsewhere — that is the whole reason it is not a popover", async () => {
    /* The thing people do with this list is read it WHILE scrolling the transcript for the message
       that produced a file. A dismiss-on-any-click popover cannot survive that, which is what made
       the old shape useless for its own purpose. */
    await mount([
      (sessionEvent("tool_call", { toolUseId: "t1", name: "Write", input: { file_path: "/a/report.md" }, parentToolUseId: null })),
      (sessionEvent("tool_result", { toolUseId: "t1", content: "ok", isError: false })),
    ]);
    openPanel();
    expect(screen.getByRole("dialog", { name: "Session summary" })).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    fireEvent.click(document.body);
    expect(screen.getByRole("dialog", { name: "Session summary" })).toBeInTheDocument();
    // …and closes on the button that opened it.
    openPanel();
    expect(screen.queryByRole("dialog", { name: "Session summary" })).toBeNull();
  });

  it("shows the session's spend, so the panel is never open onto nothing", async () => {
    // The cost moved off the pane bar and onto this control. Gating the button on the three lists
    // alone hid it — with the cost — for a session that had run a turn and written nothing, which is
    // exactly when "what is this costing me" is the live question.
    await mount([sessionEvent("usage", { costUsd: 0.42, inputTokens: 10, outputTokens: 10, numTurns: 2 })]);
    // Not ON the button — that is a glyph in a four-button strip. Inside the panel, where a number
    // has room to be labelled.
    expect(document.querySelector(".summary-btn-cost")).toBeNull();
    openPanel();
    const panel = screen.getByRole("dialog", { name: "Session summary" });
    expect(within(panel).getByText("$0.42")).toBeInTheDocument();
    expect(within(panel).getByText("2 turns")).toBeInTheDocument();
  });

  it("draws nothing at all for a session that has neither produced nor spent", async () => {
    await mount([(sessionEvent("user_message", { text: "hello", attachments: [] }))]);
    expect(screen.queryByRole("button", { name: /Summary/ })).toBeNull();
  });
});

describe("pinned beside the transcript, or floating over it", () => {
  const WROTE = [
    sessionEvent("tool_call", { toolUseId: "t1", name: "Write", input: { file_path: "/a/made.ts" }, parentToolUseId: null }),
    sessionEvent("tool_result", { toolUseId: "t1", content: "ok", isError: false }),
  ];

  /** jsdom lays nothing out, so every rect is zero and the panel would always read as "too narrow".
   *  The pane's width is the ONE measurement this behaviour turns on, so it is the one stubbed. */
  function withPaneWidth(width: number) {
    const original = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      const r = original.call(this);
      if ((this as HTMLElement).classList?.contains("session-pane")) {
        return { ...r, width, right: width, left: 0, top: 0, height: 800, bottom: 800, x: 0, y: 0, toJSON: r.toJSON } as DOMRect;
      }
      return r;
    };
    return () => { Element.prototype.getBoundingClientRect = original; };
  }

  /** The button lives in the pane bar, and the panel walks up to `.panel` and back down to
   *  `.session-pane` — so the test has to provide that shape or the measurement finds nothing. */
  async function mountInPane(width: number) {
    const restore = withPaneWidth(width);
    const api = fakeApi();
    const store = createAppStore(api);
    await store.getState().boot();
    store.setState({ transcripts: { se1: { lastSeq: 0, t: reduceAll(WROTE) } } });
    const view = render(
      <StoreContext.Provider value={store}>
        <div className="panel">
          <div className="panel-bar">
            <SessionSummaryButton item={item("i9", "s1", { kind: "session", refId: "se1", title: "A session" })} />
          </div>
          <div className="session-pane" />
        </div>
      </StoreContext.Provider>,
    );
    return { restore, ...view };
  }

  it("pins in a wide pane: the pane makes room, and a click outside does NOT close it", async () => {
    const { restore } = await mountInPane(SUMMARY_PIN_MIN_PANE + 50);
    openPanel();
    const panel = await screen.findByRole("dialog", { name: "Session summary" });
    expect(panel).toHaveAttribute("data-pinned");
    // The transcript gets out of the way rather than being covered — the whole point of pinning.
    expect(document.querySelector(".session-pane")).toHaveAttribute("data-summary-pinned");
    fireEvent.mouseDown(document.body);
    expect(screen.getByRole("dialog", { name: "Session summary" })).toBeInTheDocument();
    restore();
  });

  it("floats in a narrow pane, and a click outside dismisses it", async () => {
    /* Pinning at any width means a pane split three ways shows a summary and a sliver. Below the
       threshold the panel is an overlay you did not make room for, and those close on an outside
       click like any other. */
    const { restore } = await mountInPane(SUMMARY_PIN_MIN_PANE - 50);
    openPanel();
    const panel = await screen.findByRole("dialog", { name: "Session summary" });
    expect(panel).not.toHaveAttribute("data-pinned");
    expect(document.querySelector(".session-pane")).not.toHaveAttribute("data-summary-pinned");
    fireEvent.mouseDown(document.body);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Session summary" })).toBeNull());
    restore();
  });

  /* Height follows CONTENT, capped at the pane — a summary of three rows used to draw a column of
     empty surface the height of the window. jsdom lays nothing out, so what is checkable here is the
     handoff: the pane's height arrives as a cap for the stylesheet to clamp with, and the panel
     states no height of its own. The clamp itself is pinned in styles.test.ts, and the rendered
     result in failover-live.mjs, because only a real window has boxes.
     THE mutant: put `height: rect.height` back on the style object. */
  it("hands the pane's height over as a CAP and states no height of its own", async () => {
    const { restore } = await mountInPane(SUMMARY_PIN_MIN_PANE + 50);
    openPanel();
    const panel = await screen.findByRole("dialog", { name: "Session summary" });
    expect(panel.style.height).toBe("");
    expect(panel.style.maxHeight).toBe("");
    // 800 is the stubbed pane height. The stylesheet subtracts the panel's own inset from it.
    expect(panel.style.getPropertyValue("--summary-pane-h")).toBe("800px");
    // Still docked to the pane's top edge: shorter than the pane means top-aligned, not floated free.
    expect(panel.style.top).toBe("0px");
    restore();
  });

  it("its scroller carries the shared edge bands, and neither is drawn over content that fits", async () => {
    /* `ScrollFades` rather than a band of its own: the primitive only paints when the scroller has
       something past the edge, which is what keeps a panel whose rows fit from wearing a smear along
       the bottom of a list that ends there. THE mutant: an always-on `.summary-fade` div. */
    const { restore } = await mountInPane(SUMMARY_PIN_MIN_PANE + 50);
    openPanel();
    const panel = await screen.findByRole("dialog", { name: "Session summary" });
    const wrap = panel.querySelector(".summary-scroll-wrap")!;
    expect(wrap.querySelector(".summary-scroll")).not.toBeNull();
    const bands = [...wrap.querySelectorAll(":scope > .edge-fade")];
    expect(bands).toHaveLength(2);
    // Nothing scrolls in jsdom, so nothing is under either band, so neither is on.
    expect(bands.some((b) => b.hasAttribute("data-on"))).toBe(false);
    restore();
  });

  it("a click INSIDE the floating panel, or on its own button, is not an outside click", async () => {
    const { restore } = await mountInPane(SUMMARY_PIN_MIN_PANE - 50);
    openPanel();
    const panel = await screen.findByRole("dialog", { name: "Session summary" });
    fireEvent.mouseDown(panel);
    expect(screen.getByRole("dialog", { name: "Session summary" })).toBeInTheDocument();
    // THE mutant: close on any mousedown. The toggle would then close and reopen on one click, or
    // close before its own onClick ran — a button that cannot turn the thing it opened back off.
    fireEvent.mouseDown(screen.getByRole("button", { name: "Summary of A session" }));
    expect(screen.getByRole("dialog", { name: "Session summary" })).toBeInTheDocument();
    restore();
  });
});

describe("the session's context", () => {
  const base = () => fakeSession("se1", "s1", { cwd: "/Users/me/code/realm", model: "claude-opus-5", effort: "high", permissionMode: "acceptEdits", agentKind: "claude" });
  const memory = { agent: "claude" as const, channel: "systemPrompt" as const, basis: "modeled" as const, note: "n", realmMemoryInjected: true,
    sources: [
      { path: "/Users/me/code/realm/CLAUDE.md", origin: "project" as const, exists: true, via: "cli" as const },
      { path: "/Users/me/.claude/CLAUDE.md", origin: "user" as const, exists: false, via: "cli" as const },
      { path: "/Users/me/code/realm/AGENTS.md", origin: "project" as const, exists: true, via: "none" as const },
    ] };

  it("states where the agent runs, what it runs as, what memory reaches it and what it can call", () => {
    /* Every row is a fact the store already holds for another surface; the mutant is inventing
       one — a "Branch —" for a folder nobody asked git about, a memory file that does not exist. */
    const rows = contextRows({
      session: base(),
      env: { id: "e1", spaceId: "s1", path: "/Users/me/code/realm", branch: null, kind: "worktree", portBlockStart: null } as never,
      git: { branch: "feat/context", additions: 1, deletions: 0, dirty: 2, ahead: 0, behind: 0 },
      memory,
      servers: [{ name: "linear", status: "connected", tools: [{ name: "a" }, { name: "b" }] } as never, { name: "slack", status: "error", tools: [] } as never],
    });
    expect(rows.map((r) => [r.label, r.value])).toEqual([
      ["worktree", "realm"],
      ["branch · 2 changed", "feat/context"],
      ["Claude", "claude-opus-5 · high"],
      ["permission", "Accept edits"],
      ["memory", "Realm memory, CLAUDE.md"],
      ["connection", "linear"],
    ]);
  });

  it("draws no branch and no connections when nothing has said there are any", () => {
    const rows = contextRows({ session: base(), env: null, git: null, memory: null, servers: [] });
    expect(rows.map((r) => r.label)).toEqual(["folder", "Claude", "permission"]);
  });

  it("names Plan and Ask as the mode rather than the parked permission behind them", () => {
    const rows = contextRows({ session: fakeSession("se1", "s1", { permissionMode: "plan" }), env: null, git: null, memory: null, servers: [] });
    expect(rows.find((r) => r.label === "permission")?.value).toBe("Plan");
  });

  it("appears in the panel, and asks for the session's memory sources once it is open", async () => {
    const { api, store } = await mount([
      (sessionEvent("tool_call", { toolUseId: "t1", name: "Write", input: { file_path: "/a/made.ts" }, parentToolUseId: null })),
      (sessionEvent("tool_result", { toolUseId: "t1", content: "ok", isError: false })),
    ]);
    store.setState({ sessions: { ...store.getState().sessions, se1: base() }, gitInfo: { "/Users/me/code/realm": { branch: "main", additions: 0, deletions: 0, dirty: 0, ahead: 0, behind: 0 } } });
    openPanel();
    expect(sectionNames()).toContain("Context");
    expect(within(document.querySelector(".summary-fact")!.parentElement!).getByText("main")).toBeInTheDocument();
    await waitFor(() => expect(api.calls.some((c) => c.startsWith("memorySources:se1"))).toBe(true));
  });
});
