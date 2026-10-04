import { describe, expect, it, vi } from "vitest";
import { findSidePane } from "@realm/contracts";
import { AGENT_PANE_EVENTS, subscribeAgentPanes } from "./App";
import { createAppStore } from "./state/store";
import { fakeApi, item, session } from "./state/store.test-fakes";

/** The lead session's pane open and focused, and every agent-open broadcast captured by name. */
async function lead() {
  const api = fakeApi({ items: { s1: [item("i-lead", "s1", { kind: "session", refId: "lead", title: "Lead" })] }, sessions: [session("lead", "s1")] });
  const store = createAppStore(api);
  await store.getState().boot();
  await store.getState().openItem("i-lead");
  const handlers = new Map<string, (p: unknown) => void>();
  const off = subscribeAgentPanes(store, (event, fn) => {
    handlers.set(event, fn as (p: unknown) => void);
    return () => { handlers.delete(event); };
  });
  return { api, store, handlers, off };
}

describe("panes an agent opens", () => {
  it("puts a terminal the agent opened in the side pane of the session that asked", async () => {
    // THE MUTANT: leave `terminal.agentOpened` unheard. The server says the shell exists and the app
    // only learns of it through `items.changed`, which makes a sidebar row and no pane.
    const { api, store, handlers } = await lead();
    api.data.items.s1!.push(item("i-term", "s1", { kind: "terminal", refId: "t9", title: "Terminal" }));
    handlers.get("terminal.agentOpened")!({ spaceId: "s1", terminalId: "t9", itemId: "i-term", openedBy: "lead" });
    await vi.waitFor(() => expect(findSidePane(store.getState().layout!, "i-lead")).toMatchObject({ itemId: "i-term", tabs: ["i-term"] }));
  });

  it("hears every kind of agent open, and lets go of all of them", async () => {
    const { handlers, off } = await lead();
    expect([...handlers.keys()].sort()).toEqual([...AGENT_PANE_EVENTS].sort());
    off();
    expect(handlers.size).toBe(0);
  });
});
