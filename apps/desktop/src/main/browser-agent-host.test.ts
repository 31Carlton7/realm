import { describe, expect, it } from "vitest";
import { BrowserAgentHost, type CdpBinding } from "./browser-agent-host";
import { createBridgeCore } from "./browser-agent-bridge";

/** A fake pane: one live view ("b1") whose CDP send is programmable, plus event injection. */
function setup(opts: { responses?: Record<string, unknown>; attachFails?: boolean } = {}) {
  let emit: ((method: string, params: unknown) => void) | null = null;
  const calls: { method: string; params?: Record<string, unknown> }[] = [];
  const liveViews = new Set(["b1"]);
  const binding: CdpBinding = {
    send: async (method, params) => {
      calls.push({ method, params });
      if (method === "DOMSnapshot.captureSnapshot") return opts.responses?.[method] ?? { documents: [], strings: [] };
      if (method === "Runtime.evaluate") return { result: { value: "page text here" } };
      if (method === "Page.captureScreenshot") return { data: "c2NyZWVu" };
      return opts.responses?.[method] ?? {};
    },
    onEvent: (cb) => { emit = cb; },
  };
  const host = new BrowserAgentHost({
    attach: (id) => (opts.attachFails || !liveViews.has(id) ? null : binding),
    hasView: (id) => liveViews.has(id),
    navigate: (id, url) => (liveViews.has(id) && url.startsWith("https://allowed.") ? url : null),
    pageState: (id) => (liveViews.has(id) ? { url: "https://example.com/x", title: "Example" } : null),
  });
  return { host, calls, liveViews, emitEvent: (method: string, params: unknown) => emit?.(method, params) };
}

describe("BrowserAgentHost", () => {
  it("an op against a browser whose pane is not open fails with the tell-the-user message", async () => {
    const { host } = setup();
    await expect(host.handleOp("snapshot", { browserId: "nope" })).rejects.toThrow(/pane is not open in the app/);
  });

  it("describe reports open:false (not an error) for a missing view — browser_list needs the distinction", async () => {
    const { host } = setup();
    expect(await host.handleOp("describe", { browserId: "nope" })).toEqual({ open: false, url: "", title: "", element: null });
  });

  it("describe returns the webContents' own url/title — trustworthy identity for permission prompts", async () => {
    const { host } = setup();
    expect(await host.handleOp("describe", { browserId: "b1" })).toEqual({ open: true, url: "https://example.com/x", title: "Example", element: null });
  });

  it("navigate goes through the pane host's allowlist path and reports refusal as url:null", async () => {
    const { host } = setup();
    expect(await host.handleOp("navigate", { browserId: "b1", url: "https://allowed.example/" })).toEqual({ url: "https://allowed.example/" });
    expect(await host.handleOp("navigate", { browserId: "b1", url: "https://blocked.example/" })).toEqual({ url: null });
  });

  it("keeps the snapshot fingerprint index per browser, so the SECOND snapshot can mark [new]", async () => {
    const strings = ["BUTTON", "", "https://x/", "T", "b"];
    const snapshot = {
      documents: [{ documentURL: 2, title: 3, nodes: { parentIndex: [-1], nodeType: [1], nodeName: [0], nodeValue: [1], backendNodeId: [42], attributes: [[]], isClickable: { index: [0] } }, layout: { nodeIndex: [0], bounds: [[0, 0, 10, 10]], styles: [[1, 1, 1, 1, 1]], paintOrders: [1] } }],
      strings,
    };
    const { host } = setup({ responses: { "DOMSnapshot.captureSnapshot": snapshot, "Accessibility.getFullAXTree": { nodes: [] } } });
    const first = (await host.handleOp("snapshot", { browserId: "b1" })) as { text: string };
    expect(first.text).not.toContain("[new]");
    strings[4] = "renamed"; // nothing changed structurally; fingerprint stays → still not new
    const second = (await host.handleOp("snapshot", { browserId: "b1" })) as { text: string };
    expect(second.text).not.toContain("[new]");
  });

  it("buffers console and network CDP events and serves them through read", async () => {
    const { host, emitEvent } = setup();
    await host.handleOp("read", { browserId: "b1", kind: "text" }); // attaches + enables
    emitEvent("Runtime.consoleAPICalled", { type: "error", args: [{ value: "boom" }, { description: "obj" }] });
    emitEvent("Network.requestWillBeSent", { requestId: "r1", request: { method: "GET", url: "https://api.example/v1" } });
    emitEvent("Network.responseReceived", { requestId: "r1", response: { status: 500, mimeType: "application/json" } });
    emitEvent("Network.requestWillBeSent", { requestId: "r2", request: { method: "POST", url: "https://api.example/save" } });
    emitEvent("Network.loadingFailed", { requestId: "r2", errorText: "net::ERR_FAILED" });
    const consoleOut = (await host.handleOp("read", { browserId: "b1", kind: "console" })) as { text: string };
    expect(consoleOut.text).toContain("[error] boom obj");
    const netOut = (await host.handleOp("read", { browserId: "b1", kind: "network" })) as { text: string };
    expect(netOut.text).toContain("500 GET https://api.example/v1 (application/json)");
    expect(netOut.text).toContain("FAIL POST https://api.example/save — net::ERR_FAILED");
  });

  it("read text is the article-first page text", async () => {
    const { host } = setup();
    expect(await host.handleOp("read", { browserId: "b1", kind: "text" })).toEqual({ text: "page text here" });
  });

  it("screenshot returns jpeg data", async () => {
    const { host } = setup();
    expect(await host.handleOp("screenshot", { browserId: "b1" })).toEqual({ data: "c2NyZWVu", mimeType: "image/jpeg" });
  });

  it("a blocked download lands in the console buffer", async () => {
    const { host } = setup();
    await host.handleOp("read", { browserId: "b1", kind: "text" }); // attach
    host.noteBlockedDownload("b1", "https://evil.example/payload.dmg");
    const out = (await host.handleOp("read", { browserId: "b1", kind: "console" })) as { text: string };
    expect(out.text).toContain("download blocked");
    expect(out.text).toContain("payload.dmg");
  });

  it("release drops buffers and snapshot state with the view", async () => {
    const { host, emitEvent } = setup();
    await host.handleOp("read", { browserId: "b1", kind: "text" });
    emitEvent("Runtime.consoleAPICalled", { type: "log", args: [{ value: "before" }] });
    host.release("b1");
    const out = (await host.handleOp("read", { browserId: "b1", kind: "console" })) as { text: string };
    expect(out.text).not.toContain("before");
  });

  it("a dead view mid-session re-fails honestly instead of using the stale binding", async () => {
    const { host, liveViews } = setup();
    await host.handleOp("read", { browserId: "b1", kind: "text" });
    liveViews.delete("b1");
    await expect(host.handleOp("snapshot", { browserId: "b1" })).rejects.toThrow(/pane is not open/);
  });

  it("unknown ops are refused by name", async () => {
    const { host } = setup();
    await expect(host.handleOp("format-disk", { browserId: "b1" })).rejects.toThrow(/unknown browser host op/);
  });
});

describe("createBridgeCore", () => {
  it("registers on open, answers ops with results, and reports thrown failures", async () => {
    const sent: { id: string; method: string; params: Record<string, unknown> }[] = [];
    const core = createBridgeCore(
      async (op) => { if (op === "boom") throw new Error("no view"); return { got: op }; },
      (json) => sent.push(JSON.parse(json)),
    );
    core.onOpen();
    expect(sent[0]).toMatchObject({ method: "browserHost.register", params: {} });
    await core.onMessage(JSON.stringify({ event: "browserHost.op", payload: { callId: "c1", op: "snapshot", params: {} } }));
    expect(sent[1]).toMatchObject({ method: "browserHost.result", params: { callId: "c1", ok: true, result: { got: "snapshot" } } });
    await core.onMessage(JSON.stringify({ event: "browserHost.op", payload: { callId: "c2", op: "boom", params: {} } }));
    expect(sent[2]).toMatchObject({ method: "browserHost.result", params: { callId: "c2", ok: false, error: "no view" } });
  });

  it("ignores RPC responses, other events, and garbage without replying", async () => {
    const sent: string[] = [];
    const core = createBridgeCore(async () => ({}), (json) => sent.push(json));
    await core.onMessage(JSON.stringify({ id: "1", ok: true, result: {} }));
    await core.onMessage(JSON.stringify({ event: "items.changed", payload: {} }));
    await core.onMessage("not json at all");
    expect(sent).toEqual([]);
  });
});
