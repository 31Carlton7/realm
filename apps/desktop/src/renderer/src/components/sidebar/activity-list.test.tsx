import { describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { McpCall } from "@realm/contracts";
import { ActivityList } from "./ActivityList";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, session } from "../../state/store.test-fakes";

/**
 * The gateway's call log, tested against the component itself.
 *
 * These assertions used to run through the sidebar, because the lens rendered this feed. The lens now
 * shows the chats (see `chat-feed-view.test.tsx`), so the mount moved here rather than the coverage
 * being dropped — every behaviour below is one this component still has, and the record it is the
 * glance for (the ⌘K "MCP Activity" sheet, and a space's Connections tab) is unchanged.
 */
async function mount(api = fakeApi()) {
  const store = createAppStore(api);
  await store.getState().boot();
  /* `refreshMcpCalls` discards its answer unless an activity surface is open (`watchingCalls`), so
     the lens state is part of this component's contract rather than scenery — mounting it without
     that is mounting it in a state it is never in. */
  act(() => store.setState({ sidebarView: "activity" }));
  const r = render(<StoreContext.Provider value={store}><ActivityList /></StoreContext.Provider>);
  return { api, store, ...r };
}

const call = (id: string, tool: string, patch: Partial<McpCall> = {}): McpCall => ({
  id, sessionId: "se1", serverId: "sv1", serverName: "linear", tool,
  argsJson: "{}", resultSummary: "ok", ok: true, durationMs: 87, ts: Date.now(), ...patch,
});

describe("the gateway call log", () => {
  it("carries the TOOL on the row and the server once, in the heading", async () => {
    /* `linear__list_issues` on every row spends 240px of column on the half that never varies. */
    const { container } = await mount(fakeApi({
      mcpCalls: [call("c1", "list_issues"), call("c2", "create_issue", { ok: false, durationMs: 0, ts: Date.now() - 1 })],
    }));
    const rows = await waitFor(() => {
      const r = container.querySelectorAll(".sb-activity .item-row");
      if (r.length !== 2) throw new Error("not yet");
      return r;
    });
    expect(rows[0]!.querySelector(".activity-call")!.textContent).toBe("list_issues");
    expect(rows[0]!.getAttribute("title")).toContain("linear__list_issues");
    expect(rows[0]!.querySelector(".activity-duration")!.textContent).toBe("87ms");
    expect(container.querySelectorAll(".sb-activity .group-label")).toHaveLength(1);
    expect(container.querySelector(".sb-activity-server")!.textContent).toBe("linear");
    // A failed call is the only one that gets a mark; the verdict is in the name either way.
    expect(rows[0]!.querySelector(".activity-status")).toBeNull();
    expect(rows[1]!.querySelector(".activity-status")).not.toBeNull();
    expect(rows[1]!).toHaveAccessibleName(/failed/);
  });

  it("draws a composed empty state with the route that leads to a call", async () => {
    const { container } = await mount();
    const blank = await waitFor(() => {
      const el = container.querySelector(".sb-activity-empty");
      if (!el) throw new Error("not yet");
      return el;
    });
    expect(blank.textContent).toContain("No calls yet");
    expect(container.querySelectorAll(".sb-activity .item-row")).toHaveLength(0);
    expect(container.querySelector(".sb-activity")).toHaveClass("sb-activity-blank");
    expect(within(blank as HTMLElement).getByRole("button", { name: "Manage connections" })).toBeInTheDocument();
  });

  /* The log spans spaces; `sessions` holds only the active one. Against a real log half the headings
     came back as a truncated id — for sessions that have titles and that clicking can reach. */
  it("names a run by its session's own title, even for a session in another space", async () => {
    const api = fakeApi({
      sessions: [session("se-far", "s2", { title: "Rework the mapper" })],
      mcpCalls: [call("c1", "list_issues", { sessionId: "se-far", durationMs: 12 })],
    });
    const { container } = await mount(api);
    await waitFor(() => expect(container.querySelector(".sb-activity-session")?.textContent).toBe("Rework the mapper"));
    expect(api.calls.some((c) => c.startsWith("listAllSessions"))).toBe(true);
    // And the row leads somewhere, because the home still holds the session it came from.
    expect(container.querySelector(".sb-activity .item-row")).not.toBeDisabled();
  });

  /* A live call has to reach a feed that is open. `applyMcpCall` used to drop everything unless the
     SHEET was up, which would have left the column showing whatever was true when it was opened. */
  it("keeps the open feed current as calls arrive", async () => {
    const { store, container } = await mount();
    await waitFor(() => expect(container.querySelector(".sb-activity")).not.toBeNull());
    act(() => store.getState().applyMcpCall(call("open", "open")));
    await waitFor(() => expect(container.querySelector(".sb-activity .activity-call")!.textContent).toBe("open"));
  });
});
