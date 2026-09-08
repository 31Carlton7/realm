import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createAppStore, StoreContext } from "../../state/store";
import { fakeApi, item } from "../../state/store.test-fakes";
import { reduceAll } from "./transcript-model";
import { sessionEvent } from "@realm/contracts";
import { SessionSummaryButton } from "./SessionSummary";

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
