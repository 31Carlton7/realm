import { describe, expect, it } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ActivitySheet } from "./ActivitySheet";
import { StoreContext, createAppStore, MCP_CALLS_PAGE } from "../state/store";
import { fakeApi, mcpCall, session } from "../state/store.test-fakes";

/** Mirrors mcp-section.test.tsx's `mount`: boot, drive the real store action that opens the sheet
 *  (`openActivity`, not a raw `openSheet`) so the fetch it triggers is exercised the same way the real
 *  "Activity" button / palette entry drive it, then render. `openActivity` is awaited, so by the time
 *  `render` runs the first page is already in state — nothing here needs an extra `waitFor`. */
async function mount(overrides: Parameters<typeof fakeApi>[0] = {}) {
  const api = fakeApi(overrides);
  const store = createAppStore(api);
  await store.getState().boot();
  await store.getState().openActivity();
  render(<StoreContext.Provider value={store}><ActivitySheet /></StoreContext.Provider>);
  return { store, api };
}

describe("ActivitySheet", () => {
  it("says there are no calls yet, unfiltered", async () => {
    await mount();
    expect(screen.getByText(/No MCP calls yet — calls agents make through Realm's gateway appear here\./)).toBeInTheDocument();
  });

  it("says nothing matches once a filter narrows the loaded page to zero, distinctly from the unfiltered empty state", async () => {
    const c1 = mcpCall("c1", "se1", { ts: 100 });
    const { store } = await mount({ sessions: [session("se1", "s1")], mcpCalls: [c1] });
    await screen.findByText("srv1__echo");
    // Programmatic, not a chip click: the point is the WORDING difference once the loaded page is
    // empty for filter reasons, not the chip-click mechanics (covered by the filter test below).
    await store.getState().setMcpCallsFilter({ sessionId: "nobody-home" });
    await waitFor(() => expect(screen.getByText(/No calls match these filters\./)).toBeInTheDocument());
    expect(screen.queryByText(/No MCP calls yet/)).toBeNull();
  });

  it("renders rows from mcp.calls.list, including a blocked row's bare tool name and its '—' duration", async () => {
    const ok = mcpCall("c-ok", "se1", { ts: 3000, serverName: "srv", tool: "echo", durationMs: 1234, ok: true });
    // Blocked-call attribution (plan amendment): serverName "" + tool holding the full namespaced
    // string — must render as the bare string, never "__blocked__tool" (double-prefixed).
    const blocked = mcpCall("c-blocked", "se1", { ts: 2000, serverId: null, serverName: "", tool: "blocked__tool", durationMs: 0, ok: false });
    await mount({ sessions: [session("se1", "s1", { title: "My session" })], mcpCalls: [ok, blocked] });

    expect(screen.getByText("srv__echo")).toBeInTheDocument();
    expect(screen.getByText("1.2s")).toBeInTheDocument();
    expect(screen.getByText("blocked__tool")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
    // One occurrence per row's session column, plus the session filter chip itself.
    expect(screen.getAllByText("My session")).toHaveLength(3);
    expect(screen.getByLabelText("ok")).toBeInTheDocument();
    expect(screen.getByLabelText("error")).toBeInTheDocument();
  });

  it("formats sub-second durations in ms and clears rows on refetch when a filter changes", async () => {
    const fast = mcpCall("c-fast", "se1", { ts: 100, durationMs: 87 });
    await mount({ sessions: [session("se1", "s1")], mcpCalls: [fast] });
    expect(screen.getByText("87ms")).toBeInTheDocument();
  });

  it("expanding a row shows resultSummary verbatim, never re-parsed or reformatted", async () => {
    const raw = 'raw text with {json-ish} and [redacted] that would change if parsed';
    const c1 = mcpCall("c1", "se1", { ts: 100, resultSummary: raw, argsJson: '{"a":1}' });
    await mount({ sessions: [session("se1", "s1")], mcpCalls: [c1] });
    fireEvent.click(screen.getByRole("button", { name: /srv1__echo/ }));
    expect(screen.getByText(raw)).toBeInTheDocument();
    // argsJson IS pretty-printed (different requirement, same row) — sanity check it isn't the raw string.
    expect(screen.getByText(/"a": 1/)).toBeInTheDocument();
  });

  it("a session filter chip triggers a filtered refetch via mcp.calls.list", async () => {
    const c1 = mcpCall("c1", "se1", { ts: 100 });
    const { api } = await mount({ sessions: [session("se1", "s1", { title: "My session" })], mcpCalls: [c1] });
    fireEvent.click(screen.getByRole("button", { name: "My session" }));
    await waitFor(() => expect(api.calls).toContain("mcpCallsList:se1:*:-:50"));
  });

  it("Load more passes the last row's {ts, id} and appends; the button hides once a page comes back short", async () => {
    // Exactly MCP_CALLS_PAGE rows for the first fetch (a full page — Load more must show), one more
    // for the second page (a short page — Load more must then hide).
    const first = Array.from({ length: MCP_CALLS_PAGE }, (_, i) => mcpCall(`c${i}`, "se1", { ts: 1000 - i }));
    const older = mcpCall("c-older", "se1", { ts: 1000 - MCP_CALLS_PAGE });
    const { api, store } = await mount({ sessions: [session("se1", "s1")], mcpCalls: [...first, older] });
    expect(store.getState().mcpCalls).toHaveLength(MCP_CALLS_PAGE);
    const last = first[first.length - 1]!;

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(api.calls).toContain(`mcpCallsList:*:*:${last.ts},${last.id}:50`));
    await waitFor(() => expect(store.getState().mcpCalls).toHaveLength(MCP_CALLS_PAGE + 1));
    // The appended page (1 row) was shorter than the page size — nothing left to load.
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("a live mcp.call event prepends when it matches the active filter", async () => {
    const c1 = mcpCall("c1", "se1", { ts: 100 });
    const { store } = await mount({ sessions: [session("se1", "s1")], mcpCalls: [c1] });
    const live = mcpCall("c-live", "se1", { ts: 500, tool: "fresh" });
    store.getState().applyMcpCall(live);
    await waitFor(() => expect(screen.getByText("srv1__fresh")).toBeInTheDocument());
    expect(store.getState().mcpCalls[0]!.id).toBe("c-live"); // prepended, not appended
  });

  it("the same live event delivered twice does not duplicate the row", async () => {
    const { store } = await mount({ sessions: [session("se1", "s1")] });
    const live = mcpCall("c-live", "se1", { ts: 500 });
    store.getState().applyMcpCall(live);
    store.getState().applyMcpCall(live);
    expect(store.getState().mcpCalls.filter((c) => c.id === "c-live")).toHaveLength(1);
    await waitFor(() => expect(screen.getAllByText("srv1__echo")).toHaveLength(1));
  });

  it("a live event that does not match the active session filter is not prepended", async () => {
    const c1 = mcpCall("c1", "se1", { ts: 100 });
    const { store } = await mount({ sessions: [session("se1", "s1", { title: "My session" })], mcpCalls: [c1] });
    fireEvent.click(screen.getByRole("button", { name: "My session" }));
    await waitFor(() => expect(store.getState().mcpCallsFilter.sessionId).toBe("se1"));
    const before = store.getState().mcpCalls.length;
    const otherSession = mcpCall("c-other", "se2", { ts: 999 });
    store.getState().applyMcpCall(otherSession);
    expect(store.getState().mcpCalls).toHaveLength(before);
    expect(store.getState().mcpCalls.some((c) => c.id === "c-other")).toBe(false);
  });
});
