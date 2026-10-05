import { beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { openDatabase, type Db } from "../db/database";
import { ProfilesStore } from "../store/profiles";
import { SpacesStore } from "../store/spaces";
import { EnvironmentsStore } from "../store/environments";
import { SessionsStore } from "../store/sessions";
import { AppViewsStore } from "../store/app-views";
import { AppViews, keptResult, VIEW_RESULT_MAX_CHARS, type DrawnView } from "./views";

let db: Db;
let sessionId: string;
let views: AppViews;
beforeEach(() => {
  const home = tempDir("realm-app-views-");
  db = openDatabase(join(home, "realm.db"));
  const profile = new ProfilesStore(db).create({ name: "P", icon: "x", color: "#000" });
  const spaceId = new SpacesStore(db, home).create({ profileId: profile.id, name: "S", icon: "folder" }).id;
  const envId = new EnvironmentsStore(db).ensurePrimary(spaceId).id;
  sessionId = new SessionsStore(db).create({ spaceId, projectId: null, agentKind: "claude", model: null, effort: null, permissionMode: "default", environmentId: envId, title: "s" }).id;
  views = new AppViews({ store: new AppViewsStore(db) });
});

const RESULT: CallToolResult = { content: [{ type: "text", text: "Charted 3 values." }], structuredContent: { values: [3, 1, 2] } };
const drawn = (over: Partial<DrawnView> = {}): DrawnView => ({
  serverId: "SRV", serverName: "Charts", tool: "show_chart", fullName: "Charts__show_chart",
  def: { name: "show_chart", inputSchema: { type: "object" }, _meta: { ui: { resourceUri: "ui://charts/bar.html" } } },
  resourceUri: "ui://charts/bar.html", input: { values: [3, 1, 2] }, result: RESULT, ...over,
});

describe("pairing a drawn view with the agent's record of the call", () => {
  it("rides on the result of the call that drew it, under Claude's name for the tool, and is stored whole", () => {
    views.noteCall(sessionId, "toolu_1", "mcp__realm__Charts__show_chart", { values: [3, 1, 2] });
    views.drew(sessionId, drawn());
    const ref = views.claim(sessionId, "toolu_1");
    expect(ref).toMatchObject({ serverId: "SRV", serverName: "Charts", tool: "show_chart" });
    const stored = views.get(ref!.viewId)!;
    expect(stored).toMatchObject({ sessionId, toolUseId: "toolu_1", resourceUri: "ui://charts/bar.html", input: { values: [3, 1, 2] } });
    // The server's result as it came back — the structured half the agent's text never carried.
    expect(stored.result).toEqual(RESULT);
    expect(stored.toolDef).toMatchObject({ name: "show_chart" });
  });

  it("matches Codex's name, and an agent that names the tool only loosely when the arguments are the same", () => {
    views.drew(sessionId, drawn());
    views.noteCall(sessionId, "c1", "realm.Charts__show_chart", { values: [3, 1, 2] });
    expect(views.claim(sessionId, "c1")).not.toBeNull();
    views.drew(sessionId, drawn());
    views.noteCall(sessionId, "a1", "show_chart (Charts MCP server)", { values: [3, 1, 2] });
    expect(views.claim(sessionId, "a1")).not.toBeNull();
    views.drew(sessionId, drawn());
    views.noteCall(sessionId, "a2", "show_chart (Charts MCP server)", { values: [9] });
    expect(views.claim(sessionId, "a2")).toBeNull();
  });

  it("puts nothing under a call that drew nothing — another tool, or a result with no call behind it", () => {
    // THE MUTANT: hand the oldest waiting view to whatever result comes next, and a Bash call that
    // finished first wears the chart.
    views.drew(sessionId, drawn());
    views.noteCall(sessionId, "toolu_bash", "Bash", { command: "ls" });
    expect(views.claim(sessionId, "toolu_bash")).toBeNull();
    expect(views.claim(sessionId, "toolu_never_called")).toBeNull();
    views.noteCall(sessionId, "toolu_2", "mcp__realm__Charts__show_chart", { values: [3, 1, 2] });
    expect(views.claim(sessionId, "toolu_2")).not.toBeNull();
  });

  it("gives two calls to the same tool each their own view, by their arguments", () => {
    views.drew(sessionId, drawn({ input: { values: [1] }, result: { content: [{ type: "text", text: "one" }] } }));
    views.drew(sessionId, drawn({ input: { values: [2] }, result: { content: [{ type: "text", text: "two" }] } }));
    views.noteCall(sessionId, "second", "mcp__realm__Charts__show_chart", { values: [2] });
    views.noteCall(sessionId, "first", "mcp__realm__Charts__show_chart", { values: [1] });
    expect(views.get(views.claim(sessionId, "second")!.viewId)!.result).toMatchObject({ content: [{ text: "two" }] });
    expect(views.get(views.claim(sessionId, "first")!.viewId)!.result).toMatchObject({ content: [{ text: "one" }] });
  });

  it("keeps sessions apart, and a session that went away takes what it was waiting on", () => {
    views.drew(sessionId, drawn());
    views.noteCall("other", "toolu_1", "mcp__realm__Charts__show_chart", { values: [3, 1, 2] });
    expect(views.claim("other", "toolu_1")).toBeNull();
    views.noteCall(sessionId, "toolu_1", "mcp__realm__Charts__show_chart", { values: [3, 1, 2] });
    views.forget(sessionId);
    expect(views.claim(sessionId, "toolu_1")).toBeNull();
  });

  it("goes with its session", () => {
    views.noteCall(sessionId, "toolu_1", "mcp__realm__Charts__show_chart", { values: [3, 1, 2] });
    views.drew(sessionId, drawn());
    const ref = views.claim(sessionId, "toolu_1")!;
    db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
    expect(views.get(ref.viewId)).toBeNull();
  });
});

describe("a kept result", () => {
  it("is the whole result up to the cap, and its text alone past it", () => {
    expect(keptResult(RESULT)).toEqual(RESULT);
    const huge: CallToolResult = { content: [{ type: "text", text: "summary" }], structuredContent: { blob: "x".repeat(VIEW_RESULT_MAX_CHARS) } };
    expect(keptResult(huge)).toEqual({ content: [{ type: "text", text: "summary" }] });
  });
});
