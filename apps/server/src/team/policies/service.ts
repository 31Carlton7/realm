import {
  REALM_READ_ONLY_TOOLS, REALM_TOOL_CLASSES, classifyTool, connectorAtHost, visibleToModel,
  type TeamPolicies, type TeamPolicyConnector, type TeamPolicyTool, type ToolClassOverride, type ToolHints,
} from "@realm/contracts";
import type { McpLiveTool } from "../../mcp/hub";
import { overrideFor } from "./tool-classes";

/** What a person calls each of Realm's own toolsets. */
const PROVIDER_NAMES: Record<string, string> = {
  "realm-browser": "Browser", "realm-agent": "Agents", "realm-ui": "Questions", "realm-computer": "Computer control",
  "realm-terminal": "Terminals", "realm-app": "Realm's window", "realm-docs": "Documents", "realm-vm": "Machines",
  "realm-simulator": "Simulators", "realm-goal": "Goal", "realm-workspace": "Workspace", "realm-schedule": "Schedules",
  "realm-team": "Team", "realm-vault": "Vault", "realm-memory": "Memory",
};

const PROMPTLESS = new Set(REALM_READ_ONLY_TOOLS);

export type PoliciesDeps = {
  profileIdOf(spaceId: string): string | null;
  /** The Realm providers a session in this space would see (`McpGateway.realmProvidersFor`). */
  realmProviders(spaceId: string): string[];
  /** The server rows this space runs, in order (`McpService.effectiveServerIds`). */
  serverIds(spaceId: string): string[];
  server(id: string): { id: string; name: string; url: string } | null;
  allowedTools(spaceId: string, id: string): string[] | null;
  /** A live `tools/list` (`McpHub.tools`) — the only place a tool's annotations are read. */
  liveTools(id: string): Promise<McpLiveTool[]>;
  overrides: { forProfile(profileId: string): ReadonlyMap<string, ToolClassOverride> };
};

/**
 * The Policies page's facts (the dynamic-Teams plan, §7, read-only): every tool a role in this space
 * could call, by connector, with its class, who decided it, and what a call does TODAY. Nothing here
 * changes what runs: today a role's call asks first unless the tool is one of Realm's promptless
 * reads, because a role never runs in a mode that skips the engine's card, and the gateway hands no
 * connector's annotations on to the engines.
 */
export class PoliciesService {
  constructor(private d: PoliciesDeps) {}

  async view(spaceId: string): Promise<TeamPolicies> {
    const profileId = this.d.profileIdOf(spaceId);
    const overrides = profileId ? this.d.overrides.forProfile(profileId) : new Map<string, ToolClassOverride>();
    const tool = (connector: string, name: string, extra: { host?: string | null; annotations?: ToolHints | null }, asksToday: boolean): TeamPolicyTool => {
      const c = classifyTool({ connector, tool: name, ...extra }, overrideFor(overrides, connector, name));
      return { tool: name, ...c, asksToday };
    };

    const realm = this.d.realmProviders(spaceId).map((provider): TeamPolicyConnector => {
      const connector = `realm:${provider}`;
      const names = Object.keys(REALM_TOOL_CLASSES).filter((n) => n.startsWith(`${provider}__`));
      return {
        connector, kind: "realm", name: PROVIDER_NAMES[provider] ?? provider, icon: null, reached: true,
        tools: names.map((n) => tool(connector, n.slice(provider.length + 2), {}, !PROMPTLESS.has(n))),
      };
    }).filter((c) => c.tools.length > 0);

    const servers = await Promise.all(this.d.serverIds(spaceId).map(async (id): Promise<TeamPolicyConnector | null> => {
      const row = this.d.server(id);
      if (!row) return null;
      const connector = `mcp:${id}`;
      const host = hostOf(row.url);
      const vendor = host ? connectorAtHost(host) : undefined;
      const head = { connector, kind: "server" as const, name: vendor?.name ?? row.name, icon: vendor?.icon ?? null };
      let live: McpLiveTool[];
      try { live = await this.d.liveTools(id); } catch { return { ...head, reached: false, tools: [] }; }
      const allowed = this.d.allowedTools(spaceId, id);
      const listed = live.filter((t) => visibleToModel(t.ui) && (!allowed || allowed.includes(t.name)));
      return { ...head, reached: true, tools: listed.map((t) => tool(connector, t.name, { host, annotations: (t.def.annotations ?? null) as ToolHints | null }, true)) };
    }));

    return { spaceId, connectors: [...realm, ...servers.filter((s): s is TeamPolicyConnector => s !== null)] };
  }
}

const hostOf = (url: string): string | null => { try { return url ? new URL(url).host.toLowerCase() : null; } catch { return null; } };
