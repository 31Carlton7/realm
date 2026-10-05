import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AppView as AppViewData, MethodResult } from "@realm/contracts";

const ORIGIN = "http://3f9a1c2b4d5e6f70.mcp-view.localhost:51234";
const VIEW: AppViewData = {
  viewId: "01HQ0000000000000000000VW1", sessionId: "01HQ0000000000000000000SS1", serverId: "01HQ0000000000000000000SV1", serverName: "Charts",
  url: `${ORIGIN}/v/tok-1`, origin: ORIGIN, tool: { name: "show_chart", inputSchema: { type: "object" } },
  input: { values: [3, 1, 2] }, result: { content: [{ type: "text", text: "Charted" }] }, prefersBorder: null,
  csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] },
};

/** `apps.view` answers whatever the test last set; every call is kept. */
let answer: MethodResult<"apps.view"> = { state: "ready", view: VIEW };
const calls: { method: string; params: any }[] = [];
const listeners = new Map<string, () => void>();
vi.mock("../../rpc/client", () => ({
  rpc: () => ({
    on: (event: string, fn: () => void) => { listeners.set(event, fn); return () => listeners.delete(event); },
    call: async (method: string, params: any) => {
      calls.push({ method, params });
      if (method === "apps.view") return answer;
      if (method === "apps.release") return { ok: true };
      throw new Error(`unexpected ${method}`);
    },
  }),
}));

import { AppView, VIEW_SANDBOX } from "./AppView";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi } from "../../state/store.test-fakes";

afterEach(() => { cleanup(); calls.length = 0; listeners.clear(); answer = { state: "ready", view: VIEW }; });

async function mount(mode: "inline" | "tab" = "inline") {
  const store = createAppStore(fakeApi());
  await store.getState().boot();
  const openAppView = vi.spyOn(store.getState(), "openAppView");
  const view = render(<StoreContext.Provider value={store}>
    <AppView viewId={VIEW.viewId} mode={mode} viewRef={{ viewId: VIEW.viewId, serverId: VIEW.serverId, serverName: "Charts", tool: "show_chart" }} />
  </StoreContext.Provider>);
  return { ...view, store, openAppView };
}

const frame = () => document.querySelector<HTMLIFrameElement>("iframe.app-view-frame");

describe("a view's frame", () => {
  it("is sandboxed to scripts, its own origin and forms — no popups, no top navigation, no modals, no device", async () => {
    // THE MUTANTS: add `allow-popups` or `allow-top-navigation`, or hand the frame an `allow` list,
    // and a view can open windows, take Realm's page over, or reach the camera it declared.
    await mount();
    await waitFor(() => expect(frame()).not.toBeNull());
    const f = frame()!;
    expect(VIEW_SANDBOX).toBe("allow-scripts allow-same-origin allow-forms");
    expect(f.getAttribute("sandbox")).toBe(VIEW_SANDBOX);
    expect(f.getAttribute("allow")).toBeNull();
    expect(f.getAttribute("src")).toBe(VIEW.url);
    expect(f.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(f.getAttribute("title")).toBe("Charts: show_chart");
  });

  it("is named for the server that drew it, under its call, with a way to a tab of its own", async () => {
    const { openAppView } = await mount();
    await waitFor(() => expect(frame()).not.toBeNull());
    expect(screen.getByRole("region", { name: "View from Charts" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open in a tab" }));
    expect(openAppView).toHaveBeenCalledWith(VIEW.sessionId, { viewId: VIEW.viewId, serverId: VIEW.serverId, serverName: "Charts", tool: "show_chart" });
  });

  it("gives its address back when it goes, so the listener stops serving it", async () => {
    const { unmount } = await mount();
    await waitFor(() => expect(frame()).not.toBeNull());
    unmount();
    await waitFor(() => expect(calls.filter((c) => c.method === "apps.release").map((c) => c.params.url)).toEqual([VIEW.url]));
  });

  it("draws nothing while its server's views are off, and says why when it cannot be shown", async () => {
    answer = { state: "hidden" };
    const hidden = await mount();
    await waitFor(() => expect(calls.some((c) => c.method === "apps.view")).toBe(true));
    await act(async () => {});
    expect(hidden.container).toBeEmptyDOMElement();
    hidden.unmount();
    answer = { state: "unavailable", reason: "Charts is turned off in this space." };
    await mount();
    expect(await screen.findByText("Charts is turned off in this space.")).toBeInTheDocument();
    expect(frame()).toBeNull();
    answer = { state: "ready", view: VIEW };
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(frame()).not.toBeNull());
  });

  it("goes when its server's views are switched off while it is on screen", async () => {
    await mount();
    await waitFor(() => expect(frame()).not.toBeNull());
    answer = { state: "hidden" };
    await act(async () => { listeners.get("mcp.changed")?.(); await new Promise((r) => setTimeout(r, 0)); });
    await waitFor(() => expect(frame()).toBeNull());
    expect(calls.filter((c) => c.method === "apps.release").map((c) => c.params.url)).toContain(VIEW.url);
  });

  it("fills its tab, with no head of its own — the tab's title says whose it is", async () => {
    await mount("tab");
    await waitFor(() => expect(frame()).not.toBeNull());
    expect(document.querySelector(".app-view")?.getAttribute("data-mode")).toBe("tab");
    expect(screen.queryByRole("button", { name: "Open in a tab" })).toBeNull();
    expect(frame()!.getAttribute("loading")).toBeNull();
  });
});
