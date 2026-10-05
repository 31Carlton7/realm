import { describe, expect, it } from "vitest";
import { callableByApp, isAppViewHost, isAppViewUrl, toolUiOf, visibleToModel } from "./mcp-apps";
import { McpServerSchema, McpToolSchema } from "./mcp";
import { SessionEventSchema, StoredSessionEventSchema } from "./session-events";

describe("toolUiOf", () => {
  it("reads the resource a tool names, with both callers allowed when it names none", () => {
    expect(toolUiOf({ ui: { resourceUri: "ui://weather/dashboard" } })).toEqual({ resourceUri: "ui://weather/dashboard", visibility: ["model", "app"] });
  });

  it("reads the deprecated flat key too, and lets the nested one win when both are there", () => {
    expect(toolUiOf({ "ui/resourceUri": "ui://legacy/view" })?.resourceUri).toBe("ui://legacy/view");
    expect(toolUiOf({ ui: { resourceUri: "ui://new/view" }, "ui/resourceUri": "ui://old/view" })?.resourceUri).toBe("ui://new/view");
  });

  it("takes no view from a URI that is not ui:// — the scheme is the one a tool may name", () => {
    expect(toolUiOf({ ui: { resourceUri: "https://evil.example/page.html" } })?.resourceUri).toBeNull();
    expect(toolUiOf({ ui: { resourceUri: 42 } })?.resourceUri).toBeNull();
  });

  it("keeps an app-only tool app-only, and drops a visibility it does not know", () => {
    const ui = toolUiOf({ ui: { resourceUri: "ui://x/y", visibility: ["app", "everyone"] } });
    expect(ui?.visibility).toEqual(["app"]);
    expect(visibleToModel(ui)).toBe(false);
    expect(callableByApp(ui)).toBe(true);
  });

  it("says nothing about a tool whose _meta says nothing about views — and that tool is the agent's", () => {
    expect(toolUiOf(undefined)).toBeNull();
    expect(toolUiOf({ other: true })).toBeNull();
    expect(visibleToModel(null)).toBe(true);
    expect(callableByApp(null)).toBe(true);
  });
});

describe("a view's host", () => {
  it("is a subdomain of the reserved suffix, and nothing that merely contains it", () => {
    expect(isAppViewHost("k3j2.mcp-view.localhost")).toBe(true);
    for (const h of ["mcp-view.localhost", "localhost", "127.0.0.1", "k3j2.mcp-view.localhost.evil.example", "mcp-view.localhost.example"]) expect(isAppViewHost(h)).toBe(false);
    expect(isAppViewUrl("http://k3j2.mcp-view.localhost:51234/v/abc")).toBe(true);
    expect(isAppViewUrl("file:///Applications/Realm.app")).toBe(false);
    expect(isAppViewUrl("not a url")).toBe(false);
  });
});

describe("tool_result.view", () => {
  const stored = (payload: unknown) => StoredSessionEventSchema.safeParse({ seq: 1, sessionId: "s", event: { type: "tool_result", ts: 1, payload } });

  it("is optional: a result written before views existed still parses, unchanged", () => {
    const old = stored({ toolUseId: "t1", content: "Sunny, 72°F", isError: false });
    expect(old.success).toBe(true);
    expect(old.success && old.data.event.payload).toEqual({ toolUseId: "t1", content: "Sunny, 72°F", isError: false });
  });

  it("is kept when present, and refused when it is not a view reference", () => {
    const view = { viewId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", serverId: "01ARZ3NDEKTSV4RRFFQ69G5FAW", serverName: "Weather", tool: "get_weather" };
    const ok = SessionEventSchema.safeParse({ type: "tool_result", ts: 1, payload: { toolUseId: "t1", content: "Sunny", isError: false, view } });
    expect(ok.success && ok.data.type === "tool_result" && ok.data.payload.view).toEqual(view);
    expect(stored({ toolUseId: "t1", content: "", isError: false, view: { viewId: "v" } }).success).toBe(false);
  });
});

describe("the tool cache and the server row", () => {
  it("parse a cache written before views, and a row listed without the switch reads as showing them", () => {
    expect(McpToolSchema.safeParse({ name: "echo", description: "" }).success).toBe(true);
    expect(McpToolSchema.parse({ name: "chart", description: "", view: "ui://x/chart", appOnly: false })).toEqual({ name: "chart", description: "", view: "ui://x/chart", appOnly: false });
    const row = McpServerSchema.parse({
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAW", name: "Weather", transport: "stdio", command: "node", args: [], url: "", envKeys: [], headerKeys: [],
      authKind: "none", oauthStatus: "unconfigured", status: "idle", tools: [], allowedTools: null, enabled: true,
      scope: { kind: "space", spaceId: null }, createdAt: 1,
    });
    expect(row.showViews).toBe(true);
  });
});
