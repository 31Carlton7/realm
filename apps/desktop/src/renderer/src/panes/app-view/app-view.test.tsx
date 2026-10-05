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
      if (method === "apps.callTool") return { content: [{ type: "text", text: "Refreshed." }], structuredContent: { values: [9] } };
      throw new Error(`unexpected ${method}`);
    },
  }),
}));

import { AppView, VIEW_SANDBOX } from "./AppView";
import { ARM_MS } from "./ViewRequestCard";
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

describe("what a view asks for, held until the user clicks", () => {
  /** The view, speaking: a message posted from its own frame on its own origin, with every answer
   *  the bridge posts back to that frame recorded. */
  async function speaking() {
    const m = await mount();
    await waitFor(() => expect(frame()?.contentWindow).toBeTruthy());
    const win = frame()!.contentWindow!;
    const answers: any[] = [];
    vi.spyOn(win, "postMessage").mockImplementation(((msg: any) => { answers.push(msg); }) as any);
    const say = (data: unknown) => act(async () => { window.dispatchEvent(new MessageEvent("message", { data, origin: ORIGIN, source: win })); await new Promise((r) => setTimeout(r, 0)); });
    await say({ jsonrpc: "2.0", id: 1, method: "ui/initialize", params: { appInfo: { name: "Charts", version: "1" }, appCapabilities: {}, protocolVersion: "2026-01-26" } });
    await say({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
    return { ...m, answers, say };
  }
  const card = () => document.querySelector<HTMLElement>(".app-view-request");
  const press = async (name: string) => { await act(async () => { fireEvent.click(screen.getByRole("button", { name })); await new Promise((r) => setTimeout(r, 0)); }); };
  const armed = () => act(async () => { await new Promise((r) => setTimeout(r, ARM_MS + 30)); });

  it("tells the view it may ask for each of the three, and nothing more", async () => {
    const { answers } = await speaking();
    expect(answers[0].result.hostCapabilities).toEqual({ serverTools: {}, message: { text: {} }, openLinks: {}, sandbox: { permissions: {}, csp: VIEW.csp } });
  });

  it("holds a tool call on Realm's card, and with no click nothing is called", async () => {
    // THE MUTANT: answer `tools/call` straight through, and the view runs a vendor's tool on its own say.
    const { say } = await speaking();
    await say({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "refresh_chart", arguments: { title: "Bundle" } } });
    expect(card()).not.toBeNull();
    expect(card()!.getAttribute("data-no-agent")).toBe("view request");
    expect(card()!.textContent).toContain("The view from Charts asks to run refresh_chart.");
    expect(card()!.textContent).toContain('"title": "Bundle"');
    await armed();
    expect(calls.some((c) => c.method === "apps.callTool")).toBe(false);
  });

  it("ignores a click that lands before the card could have been read", async () => {
    const { say } = await speaking();
    await say({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "refresh_chart", arguments: {} } });
    await press("Run refresh_chart");
    expect(card()).not.toBeNull();
    expect(calls.some((c) => c.method === "apps.callTool")).toBe(false);
  });

  it("runs it on Allow and hands the view the result; on Don't run tells it no, and runs nothing", async () => {
    const { say, answers } = await speaking();
    await say({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "refresh_chart", arguments: { title: "Bundle" } } });
    await armed();
    await press("Run refresh_chart");
    await waitFor(() => expect(answers.some((a) => a.id === 7)).toBe(true));
    expect(calls.find((c) => c.method === "apps.callTool")?.params).toEqual({ viewId: VIEW.viewId, name: "refresh_chart", arguments: { title: "Bundle" } });
    expect(answers.find((a) => a.id === 7)).toEqual({ jsonrpc: "2.0", id: 7, result: { content: [{ type: "text", text: "Refreshed." }], structuredContent: { values: [9] } } });
    expect(card()).toBeNull();
    calls.length = 0;
    await say({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "refresh_chart", arguments: {} } });
    await armed();
    await press("Don't run");
    await waitFor(() => expect(answers.some((a) => a.id === 8)).toBe(true));
    expect(answers.find((a) => a.id === 8).error.message).toBe("The user did not allow the call");
    expect(calls.some((c) => c.method === "apps.callTool")).toBe(false);
  });

  it("puts a message in the prompter beside what the user was writing — it never sends it", async () => {
    const { say, answers, store } = await speaking();
    store.getState().setDraft(VIEW.sessionId, "My own words");
    await say({ jsonrpc: "2.0", id: 9, method: "ui/message", params: { role: "user", content: [{ type: "text", text: "Which release grew most?" }] } });
    expect(card()!.textContent).toContain("Which release grew most?");
    await armed();
    await press("Put in the prompter");
    expect(store.getState().drafts[VIEW.sessionId]).toBe("My own words\n\nWhich release grew most?");
    expect(answers.find((a) => a.id === 9)).toEqual({ jsonrpc: "2.0", id: 9, result: {} });
    expect(calls.some((c) => c.method === "sessions.send")).toBe(false);
  });

  it("opens a link only on the click, with the whole address on the card and its host set apart", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const { say } = await speaking();
    await say({ jsonrpc: "2.0", id: 10, method: "ui/open-link", params: { url: "https://example.com/releases/sizes" } });
    expect(document.querySelector(".app-view-request-host")?.textContent).toBe("example.com");
    expect(card()!.querySelector("a")).toBeNull();
    await armed();
    expect(open).not.toHaveBeenCalled();
    await press("Open example.com");
    expect(open).toHaveBeenCalledWith("https://example.com/releases/sizes", "_blank");
    open.mockRestore();
  });

  it("drops a request still waiting when the view goes: the card goes with the frame, and nothing it asked for happens", async () => {
    const { say, answers, unmount, store } = await speaking();
    await say({ jsonrpc: "2.0", id: 11, method: "ui/message", params: { role: "user", content: [{ type: "text", text: "hi" }] } });
    expect(card()).not.toBeNull();
    unmount();
    await act(async () => { await new Promise((r) => setTimeout(r, ARM_MS + 30)); });
    expect(card()).toBeNull();
    expect(store.getState().drafts[VIEW.sessionId] ?? "").toBe("");
    // The frame is gone, so it is told nothing more — not even the refusal.
    expect(answers.find((a) => a.id === 11)).toBeUndefined();
  });
});
