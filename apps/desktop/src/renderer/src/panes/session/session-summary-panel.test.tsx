import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  return { store, ...view };
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

  it("a non-media output opens the artifact sheet for its path", async () => {
    const { store } = await mount([
      (sessionEvent("tool_call", { toolUseId: "t1", name: "Write", input: { file_path: "/a/report.md" }, parentToolUseId: null })),
      (sessionEvent("tool_result", { toolUseId: "t1", content: "ok", isError: false })),
    ]);
    openPanel();
    fireEvent.click(screen.getByRole("button", { name: /report.md/ }));
    expect(store.getState().sheet).toEqual({ kind: "artifact", path: "/a/report.md" });
  });
});
