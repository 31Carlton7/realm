import { describe, expect, it } from "vitest";
import type { ToolClassOverride } from "@realm/contracts";
import type { McpLiveTool } from "../../mcp/hub";
import { PoliciesService, type PoliciesDeps } from "./service";

const live = (name: string, annotations?: Record<string, unknown>, ui: McpLiveTool["ui"] = null): McpLiveTool =>
  ({ name, description: "", inputSchema: { type: "object" }, ui, def: { name, inputSchema: { type: "object" }, ...(annotations ? { annotations } : {}) } });

const SERVERS: Record<string, { id: string; name: string; url: string }> = {
  LIN: { id: "LIN", name: "realm-linear", url: "https://mcp.linear.app/mcp" },
  CRM: { id: "CRM", name: "acme-crm", url: "" },
  GONE: { id: "GONE", name: "offline", url: "https://offline.example.com/mcp" },
};

function service(over: Partial<PoliciesDeps> = {}, overrides = new Map<string, ToolClassOverride>()) {
  const deps: PoliciesDeps = {
    profileIdOf: () => "P1",
    realmProviders: () => ["realm-team", "realm-vault"],
    serverIds: () => ["LIN", "CRM", "GONE"],
    server: (id) => SERVERS[id] ?? null,
    allowedTools: () => null,
    liveTools: async (id) => {
      if (id === "LIN") return [live("list_issues", { readOnlyHint: true }), live("save_issue", { readOnlyHint: true }), live("merge_diff")];
      if (id === "CRM") return [live("get_deal", { readOnlyHint: true }), live("update_deal"), live("email_contact", { readOnlyHint: true }), live("open_view", undefined, { resourceUri: "ui://v", visibility: ["app"] } as never)];
      throw new Error("ECONNREFUSED");
    },
    overrides: { forProfile: () => overrides },
    ...over,
  };
  return new PoliciesService(deps);
}

describe("PoliciesService.view", () => {
  it("names a connector Realm offers by its vendor and classes it from the vendor table, not the server's word", async () => {
    const v = await service().view("S");
    const linear = v.connectors.find((c) => c.connector === "mcp:LIN")!;
    expect(linear).toMatchObject({ name: "Linear", icon: "linear", reached: true });
    expect(linear.tools.map((t) => [t.tool, t.class, t.source])).toEqual([
      ["list_issues", "read", "vendor"], ["save_issue", "reversible-external", "vendor"], ["merge_diff", "irreversible-external", "vendor"],
    ]);
  });

  it("keeps a server it could not reach, with no tools, rather than dropping it", async () => {
    const v = await service().view("S");
    expect(v.connectors.find((c) => c.connector === "mcp:GONE")).toMatchObject({ name: "offline", reached: false, tools: [] });
  });

  it("lists only what a role could be handed: the space's allowlist, and never a tool only its view may call", async () => {
    const v = await service({ allowedTools: (_s, id) => (id === "CRM" ? ["get_deal", "update_deal", "open_view"] : null) }).view("S");
    // THE MUTANT: the app-only filter dropped — `open_view` would show as a tool a role can call.
    expect(v.connectors.find((c) => c.connector === "mcp:CRM")!.tools.map((t) => t.tool)).toEqual(["get_deal", "update_deal"]);
  });

  it("says a connector's every call asks today, and Realm's own only where the tool is not a promptless read", async () => {
    const v = await service().view("S");
    expect(v.connectors.filter((c) => c.kind === "server").flatMap((c) => c.tools).every((t) => t.asksToday)).toBe(true);
    const team = v.connectors.find((c) => c.connector === "realm:realm-team")!;
    expect(team.name).toBe("Team");
    expect(team.tools.filter((t) => !t.asksToday).map((t) => t.tool)).toEqual(["record_list", "review_status"]);
    expect(team.tools.find((t) => t.tool === "record_read")).toMatchObject({ class: "read", asksToday: true });
    expect(v.connectors.find((c) => c.connector === "realm:realm-vault")!.tools.find((t) => t.tool === "vault_http"))
      .toMatchObject({ class: "irreversible-external", asksToday: true });
  });

  it("applies a person's raise, and sets aside a lowering nothing confirmed", async () => {
    const overrides = new Map<string, ToolClassOverride>([
      ["mcp:CRM\tget_deal", { class: "irreversible-external", verb: "sync", sealed: false }],
      ["mcp:CRM\t*", { class: "read", verb: null, sealed: false }],
    ]);
    const crm = (await service({}, overrides).view("S")).connectors.find((c) => c.connector === "mcp:CRM")!;
    expect(crm.tools.find((t) => t.tool === "get_deal")).toMatchObject({ class: "irreversible-external", source: "you", verb: "sync" });
    expect(crm.tools.find((t) => t.tool === "update_deal")).toMatchObject({ class: "irreversible-external", source: "unclassified", overrideIgnored: true });
    // A send that labels itself read-only is held up by the floor, and the wildcard cannot pull it down.
    expect(crm.tools.find((t) => t.tool === "email_contact")).toMatchObject({ class: "irreversible-external", source: "server", floor: "email", overrideIgnored: true });
  });

  it("reads no overrides for a space with no profile", async () => {
    let asked = false;
    await service({ profileIdOf: () => null, overrides: { forProfile: () => { asked = true; return new Map(); } } }).view("S");
    expect(asked).toBe(false);
  });
});
