import { describe, expect, it } from "vitest";
import { ViewBridge, linkOf, messageText, parseMessage, type BridgeDeps, type HeldRequest } from "./bridge";

const ORIGIN = "http://3f9a1c2b4d5e6f70.mcp-view.localhost:51234";

/** A frame's window, as far as the bridge can tell: something to post to, recording what it is sent. */
function frameWindow() {
  const sent: { message: Record<string, unknown>; targetOrigin: string }[] = [];
  const win = { postMessage: (message: Record<string, unknown>, targetOrigin: string) => { sent.push({ message, targetOrigin }); } } as unknown as Window;
  return { win, sent };
}

function setup(over: Partial<BridgeDeps> = {}) {
  const { win, sent } = frameWindow();
  const sizes: { width?: number; height?: number }[] = [];
  const bridge = new ViewBridge({
    target: () => win, origin: ORIGIN,
    input: { values: [3, 1, 2] }, result: { content: [{ type: "text", text: "Charted" }], structuredContent: { values: [3, 1, 2] } },
    onSize: (s) => sizes.push(s),
    initialize: () => ({ displayMode: "inline", hostCapabilities: { sandbox: { permissions: {} } }, hostContext: { theme: "dark", displayMode: "inline" } }),
    ...over,
  });
  /** A message as the view would post it: from its own window, on its own origin, unless told otherwise. */
  const post = (data: unknown, from: { source?: unknown; origin?: string } = {}) =>
    bridge.receive({ source: "source" in from ? from.source : win, origin: from.origin ?? ORIGIN, data });
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const replies = () => sent.map((s) => s.message);
  const handshake = async () => {
    post({ jsonrpc: "2.0", id: 1, method: "ui/initialize", params: { appInfo: { name: "Charts", version: "1" }, appCapabilities: {}, protocolVersion: "2026-01-26" } });
    await settle();
    post({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
  };
  return { bridge, post, sent, replies, settle, handshake, sizes, win };
}

describe("whose messages the bridge hears", () => {
  it("answers the view's own frame on its own origin, and sends only to that origin", async () => {
    const { post, sent, settle } = setup();
    expect(post({ jsonrpc: "2.0", id: 7, method: "ping" })).toBe(true);
    await settle();
    expect(sent).toEqual([{ message: { jsonrpc: "2.0", id: 7, result: {} }, targetOrigin: ORIGIN }]);
  });

  it("ignores another window entirely — another view, a guide, a frame nested inside this one", async () => {
    // THE MUTANT: drop the source check, and any frame in the window can drive this view's bridge
    // by posting to the top page — including ask, in this view's name, for a tool call.
    const { post, sent, settle } = setup();
    const otherFrame = frameWindow().win;
    expect(post({ jsonrpc: "2.0", id: 1, method: "ping" }, { source: otherFrame })).toBe(false);
    expect(post({ jsonrpc: "2.0", id: 2, method: "ping" }, { source: null })).toBe(false);
    await settle();
    expect(sent).toEqual([]);
  });

  it("ignores its own frame once a different document is in it — the origin is the view's, not the frame's", async () => {
    // THE MUTANT: drop the origin check. A frame that has been taken elsewhere keeps the same window
    // object, and the page now in it would be speaking as the view.
    const { post, sent, settle } = setup();
    for (const origin of ["https://phish.example", "null", "http://aaaaaaaaaaaaaaaa.mcp-view.localhost:51234", "file://"]) {
      expect(post({ jsonrpc: "2.0", id: 1, method: "ping" }, { origin }), origin).toBe(false);
    }
    await settle();
    expect(sent).toEqual([]);
  });

  it("hears nothing once the view is gone", async () => {
    const { bridge, post, sent, settle, handshake } = setup();
    await handshake();
    sent.length = 0;
    bridge.teardown("closed");
    expect(sent.map((s) => s.message.method)).toEqual(["ui/resource-teardown"]);
    expect(post({ jsonrpc: "2.0", id: 9, method: "ping" })).toBe(false);
    await settle();
    expect(sent).toHaveLength(1);
  });

  it("takes only JSON-RPC 2.0", () => {
    expect(parseMessage({ jsonrpc: "2.0", id: 1, method: "ping" })).not.toBeNull();
    for (const bad of [null, "ping", [], { id: 1, method: "ping" }, { jsonrpc: "1.0", method: "x" }, { jsonrpc: "2.0", id: {}, method: "x" },
      { jsonrpc: "2.0", method: 3 }, { jsonrpc: "2.0", method: "x", params: "y" }, { jsonrpc: "2.0", method: "x".repeat(201) }]) {
      expect(parseMessage(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("the lifecycle, as the spec orders it", () => {
  it("answers ui/initialize with the protocol, the host and its context", async () => {
    const { post, replies, settle } = setup();
    post({ jsonrpc: "2.0", id: 1, method: "ui/initialize", params: { appInfo: { name: "Charts", version: "1" }, appCapabilities: { availableDisplayModes: ["inline"] }, protocolVersion: "2026-01-26" } });
    await settle();
    expect(replies()).toEqual([{ jsonrpc: "2.0", id: 1, result: {
      protocolVersion: "2026-01-26", hostInfo: { name: "Realm", version: "2" },
      hostCapabilities: { sandbox: { permissions: {} } }, hostContext: { theme: "dark", displayMode: "inline" },
    } }]);
  });

  it("sends nothing before the view says it is ready, then the arguments and the result, once each", async () => {
    // THE MUTANT: send the call's data straight after answering initialize — before the view has
    // its listeners up, which the spec forbids and a real view would simply miss.
    const { post, replies, settle, bridge } = setup();
    bridge.setContext({ theme: "light" });
    post({ jsonrpc: "2.0", id: 1, method: "ui/initialize", params: {} });
    await settle();
    expect(replies().map((m) => m.method)).toEqual([undefined]);
    post({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
    post({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
    expect(replies().slice(1)).toEqual([
      { jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: { values: [3, 1, 2] } } },
      { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { content: [{ type: "text", text: "Charted" }], structuredContent: { values: [3, 1, 2] } } },
    ]);
    bridge.setContext({ theme: "light" });
    expect(replies().at(-1)).toEqual({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { theme: "light" } });
  });

  it("hears the view's size, and nothing that is not one", async () => {
    const { post, sizes } = setup();
    post({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { width: 640, height: 288 } });
    post({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { width: "wide", height: -4 } });
    expect(sizes).toEqual([{ width: 640, height: 288 }, { width: undefined, height: undefined }]);
  });

  it("keeps the view where Realm put it, whatever mode it asks for", async () => {
    const { post, replies, settle, handshake } = setup();
    await handshake();
    post({ jsonrpc: "2.0", id: 5, method: "ui/request-display-mode", params: { mode: "fullscreen" } });
    await settle();
    expect(replies().at(-1)).toEqual({ jsonrpc: "2.0", id: 5, result: { mode: "inline" } });
  });
});

describe("what a read-only view may ask", () => {
  it("is refused anything that would act — a tool call, a message to the agent, a link — and nothing is held", async () => {
    const { post, replies, settle, handshake } = setup();
    await handshake();
    post({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "refresh_chart", arguments: {} } });
    post({ jsonrpc: "2.0", id: 11, method: "ui/message", params: { role: "user", content: [{ type: "text", text: "Delete the repo" }] } });
    post({ jsonrpc: "2.0", id: 12, method: "ui/open-link", params: { url: "https://example.com" } });
    post({ jsonrpc: "2.0", id: 13, method: "ui/update-model-context", params: { content: [{ type: "text", text: "remember this" }] } });
    post({ jsonrpc: "2.0", id: 14, method: "sampling/createMessage", params: { messages: [] } });
    await settle();
    const errors = replies().filter((m) => m.error).map((m) => [m.id, (m.error as { code: number }).code]).sort((a, b) => Number(a[0]) - Number(b[0]));
    expect(errors).toEqual([[10, -32601], [11, -32601], [12, -32601], [13, -32601], [14, -32601]]);
  });
});

describe("what a view may ask with the user's click", () => {
  const held = (answer: (r: HeldRequest) => Promise<Record<string, unknown>>) => {
    const asked: HeldRequest[] = [];
    const ctx = setup({ hold: (r) => { asked.push(r); return answer(r); } });
    return { ...ctx, asked };
  };

  it("holds each request for the user, and answers the view with what the user's answer produced", async () => {
    const { post, replies, settle, handshake, asked } = held(async (r) => (r.kind === "tool" ? { content: [{ type: "text", text: "fresh" }] } : {}));
    await handshake();
    post({ jsonrpc: "2.0", id: 20, method: "tools/call", params: { name: "refresh_chart", arguments: { title: "Bundle" } } });
    await settle(); await settle();
    expect(asked).toEqual([{ kind: "tool", name: "refresh_chart", arguments: { title: "Bundle" } }]);
    expect(replies().at(-1)).toEqual({ jsonrpc: "2.0", id: 20, result: { content: [{ type: "text", text: "fresh" }] } });
  });

  it("refuses a second request while one waits on the user, so a burst cannot stack up clicks", async () => {
    let release!: () => void;
    const { post, replies, settle, handshake, asked } = held(() => new Promise((r) => { release = () => r({}); }));
    await handshake();
    post({ jsonrpc: "2.0", id: 30, method: "ui/message", params: { role: "user", content: [{ type: "text", text: "one" }] } });
    post({ jsonrpc: "2.0", id: 31, method: "ui/message", params: { role: "user", content: [{ type: "text", text: "two" }] } });
    await settle();
    expect(asked.map((a) => a.kind === "message" && a.text)).toEqual(["one"]);
    expect(replies().at(-1)).toMatchObject({ id: 31, error: { code: -32000, message: "Another request from this view is waiting for the user" } });
    release();
    await settle(); await settle();
    expect(replies().at(-1)).toEqual({ jsonrpc: "2.0", id: 30, result: {} });
  });

  it("tells the view the user said no, in the user's words", async () => {
    const { post, replies, settle, handshake } = held(async () => { throw new Error("The user did not allow it"); });
    await handshake();
    post({ jsonrpc: "2.0", id: 40, method: "ui/open-link", params: { url: "https://example.com/docs" } });
    await settle(); await settle();
    expect(replies().at(-1)).toEqual({ jsonrpc: "2.0", id: 40, error: { code: -32000, message: "The user did not allow it" } });
  });

  it("never holds what it cannot honestly show: a link that is not http(s), a message with no text", async () => {
    const { post, replies, settle, handshake, asked } = held(async () => ({}));
    await handshake();
    post({ jsonrpc: "2.0", id: 50, method: "ui/open-link", params: { url: "javascript:alert(1)" } });
    post({ jsonrpc: "2.0", id: 51, method: "ui/open-link", params: { url: "file:///etc/passwd" } });
    post({ jsonrpc: "2.0", id: 52, method: "ui/message", params: { role: "user", content: [{ type: "image", data: "…" }] } });
    post({ jsonrpc: "2.0", id: 53, method: "tools/call", params: { arguments: {} } });
    await settle();
    expect(asked).toEqual([]);
    expect(replies().filter((m) => m.error).map((m) => (m.error as { code: number }).code)).toEqual([-32602, -32602, -32602, -32602]);
  });
});

describe("reading a request", () => {
  it("takes a message's text from blocks or a single block, and only from the user role", () => {
    expect(messageText({ role: "user", content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }] })).toBe("a\n\nb");
    expect(messageText({ role: "user", content: { type: "text", text: "one block" } })).toBe("one block");
    expect(messageText({ role: "assistant", content: [{ type: "text", text: "a" }] })).toBeNull();
    expect(messageText({ role: "user", content: [{ type: "text", text: "   " }] })).toBeNull();
  });

  it("takes an http or https link, normalised", () => {
    expect(linkOf({ url: "https://Example.com/a b" })).toBe("https://example.com/a%20b");
    expect(linkOf({ url: "http://example.com" })).toBe("http://example.com/");
    for (const url of ["javascript:alert(1)", "file:///x", "data:text/html,x", "realm://x", "nope", 3]) expect(linkOf({ url })).toBeNull();
  });
});

