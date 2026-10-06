import { describe, expect, it } from "vitest";
import { MCP_SECRET_STORAGE_NOTE, McpServerNameSchema, McpServerSchema, mcpSupportNote } from "./mcp";
import { AGENT_META } from "./presets";
import { Methods } from "./rpc";
import type { AgentKind } from "./entities";

const kinds = Object.keys(AGENT_META) as AgentKind[];
const SPACE = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const SERVER = "01ARZ3NDEKTSV4RRFFQ69G5FAW";

describe("mcpSupportNote", () => {
  it("names the agent, so a note rendered for the wrong session is visibly wrong", () => {
    for (const kind of kinds) expect(mcpSupportNote(kind)).toContain(AGENT_META[kind].label);
  });

  it("explains the gateway for every agent that takes MCP", () => {
    for (const kind of ["claude", "codex", "acp:cursor", "acp:gemini"] as const) {
      expect(mcpSupportNote(kind)).toMatch(/Realm's gateway/);
      expect(mcpSupportNote(kind)).toMatch(/Activity/);
    }
  });

  it("says the fake agent ignores them entirely", () => {
    expect(mcpSupportNote("fake")).toMatch(/does not connect to MCP servers/);
  });
});

describe("McpServerNameSchema", () => {
  it("accepts what every agent can key a server by, and rejects what one of them cannot", () => {
    for (const ok of ["realm", "realm-mcp", "realm_mcp", "v2", "A1_b-c"]) expect(McpServerNameSchema.safeParse(ok).success).toBe(true);
    // A dot would open a nested TOML table under Codex's `[mcp_servers.NAME]`; a space or quote breaks
    // the key outright; the rest are not addressable.
    for (const bad of ["", "has space", "dot.ted", "-leading", 'quo"te', "sla/sh", "x".repeat(65)]) {
      expect(McpServerNameSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("McpServerSchema", () => {
  const listed = {
    id: SERVER, name: "airtable", transport: "stdio" as const,
    command: "/usr/bin/node", args: ["/abs/server.mjs"], url: "",
    envKeys: ["AIRTABLE_API_KEY"], headerKeys: [],
    authKind: "secrets" as const, oauthStatus: "unconfigured" as const, status: "idle" as const,
    tools: [{ name: "search", description: "Search records" }], allowedTools: null,
    enabled: true, scope: { kind: "space" as const, spaceId: null }, createdAt: 1,
  };

  it("carries no field a secret VALUE could travel in", () => {
    // The guarantee is structural, not a convention someone has to remember: strip() drops anything the
    // schema does not name, so a caller that hands it `env` gets a result without one.
    const parsed = McpServerSchema.parse({ ...listed, env: { AIRTABLE_API_KEY: "pat-real-secret" }, headers: { Authorization: "Bearer x" } });
    expect(JSON.stringify(parsed)).not.toContain("pat-real-secret");
    expect(JSON.stringify(parsed)).not.toContain("Bearer x");
    expect(Object.keys(McpServerSchema.shape).filter((k) => k === "env" || k === "headers" || k === "secrets")).toEqual([]);
  });

});

describe("MCP_SECRET_STORAGE_NOTE", () => {
  it("says plainly that keys are unencrypted, and where they are", () => {
    // A vaguer sentence would be worse than none: the point is that a user typing an API key knows
    // exactly what they are agreeing to.
    expect(MCP_SECRET_STORAGE_NOTE).toMatch(/plain text/);
    expect(MCP_SECRET_STORAGE_NOTE).toMatch(/not encrypted/);
    expect(MCP_SECRET_STORAGE_NOTE).toMatch(/realm\.db/);
  });
});

describe("mcp methods", () => {
  it("are registered with zod params like their neighbours", () => {
    expect(Methods["mcp.list"].params.safeParse({ spaceId: "not-a-ulid" }).success).toBe(false);
    expect(Methods["mcp.list"].params.safeParse({ spaceId: SPACE }).success).toBe(true);
    expect(Methods["mcp.add"].params.safeParse({ spaceId: SPACE, name: "bad name", transport: "stdio" }).success).toBe(false);
    expect(Methods["mcp.add"].params.safeParse({ spaceId: SPACE, name: "ok", transport: "smtp" }).success).toBe(false);
    expect(Methods["mcp.setEnabled"].params.safeParse({ spaceId: SPACE, id: SERVER, enabled: true }).success).toBe(true);
    expect(Methods["mcp.remove"].params.safeParse({ id: "nope" }).success).toBe(false);
  });

  it("default `mcp.add` to enabled in no space at all, rather than in one it was not told about", () => {
    const p = Methods["mcp.add"].params.parse({ name: "ok", transport: "http", url: "https://mcp.vercel.com" });
    expect(p.spaceId).toBeNull();
    expect(p.env).toEqual({});
    expect(p.headers).toEqual({});
  });

  it("let `mcp.update` omit env/headers, because a client is never given them to send back", () => {
    const p = Methods["mcp.update"].params.parse({ id: SERVER, name: "renamed" });
    expect(p.env).toBeUndefined();
    expect(p.headers).toBeUndefined();
  });

});

describe("gateway methods (Plan 9 W1 — contracts only, no handlers yet)", () => {

  it("mcp.setAllowedTools accepts a list or null (= every tool)", () => {
    expect(Methods["mcp.setAllowedTools"].params.safeParse({ spaceId: SPACE, id: SERVER, tools: ["search"] }).success).toBe(true);
    expect(Methods["mcp.setAllowedTools"].params.safeParse({ spaceId: SPACE, id: SERVER, tools: null }).success).toBe(true);
    expect(Methods["mcp.setAllowedTools"].params.safeParse({ spaceId: SPACE, id: SERVER }).success).toBe(false);
  });

  it("mcp.calls.list makes every filter optional, and caps limit at 200", () => {
    expect(Methods["mcp.calls.list"].params.safeParse({}).success).toBe(true);
    expect(Methods["mcp.calls.list"].params.safeParse({ sessionId: SPACE, serverId: SERVER, before: { ts: 100, id: SERVER }, limit: 50 }).success).toBe(true);
    expect(Methods["mcp.calls.list"].params.safeParse({ limit: 201 }).success).toBe(false);
    expect(Methods["mcp.calls.list"].params.safeParse({ limit: 0 }).success).toBe(false);
  });

  it("mcp.calls.list's `before` is a composite {ts, id} cursor, not a plain ts — a plain number is rejected", () => {
    // W1 review amendment (binding on W3): a plain `before: ts` cursor drops same-millisecond siblings
    // at a page boundary. `McpCallLogStore.list`'s doc comment has the full reasoning.
    expect(Methods["mcp.calls.list"].params.safeParse({ before: 100 }).success).toBe(false);
    expect(Methods["mcp.calls.list"].params.safeParse({ before: { ts: 100 } }).success).toBe(false);
    expect(Methods["mcp.calls.list"].params.safeParse({ before: { ts: 100, id: "not-a-ulid" } }).success).toBe(false);
  });

  it("mcp.oauth.start/disconnect and mcp.retry are all keyed by server id alone", () => {
    for (const m of ["mcp.oauth.start", "mcp.oauth.disconnect", "mcp.retry"] as const) {
      expect(Methods[m].params.safeParse({ id: SERVER }).success).toBe(true);
      expect(Methods[m].params.safeParse({}).success).toBe(false);
    }
    expect(Methods["mcp.oauth.start"].result.safeParse({ authUrl: "https://example.com/authorize" }).success).toBe(true);
  });

});
