import { describe, expect, it } from "vitest";
import {
  AGENT_MCP_TRANSPORTS, MCP_SECRET_STORAGE_NOTE, McpServerNameSchema, McpServerSchema,
  McpTransportSchema, agentSupportsTransport, mcpSupportNote,
} from "./mcp";
import { AGENT_META } from "./presets";
import { Methods, Events } from "./rpc";
import type { AgentKind } from "./entities";

const kinds = Object.keys(AGENT_META) as AgentKind[];
const SPACE = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const SERVER = "01ARZ3NDEKTSV4RRFFQ69G5FAW";

describe("AGENT_MCP_TRANSPORTS", () => {
  it("has a row for every agent kind", () => {
    expect(Object.keys(AGENT_MCP_TRANSPORTS).sort()).toEqual(kinds.sort());
  });

  it("gives Codex stdio and http but NOT sse", () => {
    // The one asymmetry that bites. `codex`'s RawMcpServerConfig has `url`/`http_headers` and no SSE
    // variant, so an sse row here would produce a server that is configured, listed, and dials nothing.
    expect([...AGENT_MCP_TRANSPORTS.codex]).toEqual(["stdio", "http"]);
    expect(agentSupportsTransport("codex", "sse")).toBe(false);
    expect(agentSupportsTransport("codex", "http")).toBe(true);
  });

  it("gives every other real agent all three, and the fake none", () => {
    for (const kind of ["claude", "acp:cursor", "acp:gemini"] as const) {
      expect([...AGENT_MCP_TRANSPORTS[kind]].sort()).toEqual(["http", "sse", "stdio"]);
    }
    expect([...AGENT_MCP_TRANSPORTS.fake]).toEqual([]);
    for (const t of McpTransportSchema.options) expect(agentSupportsTransport("fake", t)).toBe(false);
  });
});

describe("mcpSupportNote", () => {
  it("names the agent, so a note rendered for the wrong session is visibly wrong", () => {
    for (const kind of kinds) expect(mcpSupportNote(kind)).toContain(AGENT_META[kind].label);
  });

  it("says out loud that Codex will skip an sse server", () => {
    expect(mcpSupportNote("codex")).toMatch(/no sse support/);
    expect(mcpSupportNote("codex")).toMatch(/skipped/);
  });

  it("promises nothing extra for the agents that take everything", () => {
    expect(mcpSupportNote("claude")).not.toMatch(/skipped/);
    expect(mcpSupportNote("acp:cursor")).not.toMatch(/skipped/);
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
    envKeys: ["AIRTABLE_API_KEY"], headerKeys: [], enabled: true, createdAt: 1,
  };

  it("round-trips a listed server", () => {
    expect(McpServerSchema.parse(listed)).toEqual(listed);
  });

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

  it("broadcast a payload-free mcp.changed, since add/edit/remove change what EVERY space lists", () => {
    expect(Events["mcp.changed"].safeParse({}).success).toBe(true);
  });
});
