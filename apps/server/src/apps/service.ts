import type { MethodResult } from "@realm/contracts";
import { RpcError } from "../store/rows";
import type { McpGateway } from "../mcp/gateway";
import type { McpHub } from "../mcp/hub";
import type { McpService } from "../mcp/service";
import type { McpServersStore } from "../store/mcp";
import type { SessionsStore } from "../store/sessions";
import { approvedCsp, declaresCsp, viewCsp } from "./csp";
import type { AppViewServer } from "./server";
import type { AppViews } from "./views";

/**
 * What the renderer asks of a view (`apps.view`): the frame's address, with everything checked that
 * decides whether there should be a frame at all.
 *
 * The view is the server's, so the server is asked again each time — it must still be a Connection,
 * still on in the session's space, and still showing views, because a person who turned any of those
 * off did not mean "except for the views already in the transcript". Only then is the template read
 * (through the hub, which holds it for the connection), its CSP built from what it declared, and the
 * HTML served on an origin of its own.
 */
export class AppViewService {
  constructor(private readonly d: {
    views: AppViews; hub: McpHub; mcp: McpService; servers: McpServersStore; sessions: SessionsStore; server: AppViewServer;
    /** Where a view's own tool call goes once the user has allowed it — the gateway's policy and
     *  Activity, exactly as an agent's call meets them. */
    gateway: Pick<McpGateway, "callForView">;
    /** Where the CSP each view is served under is written down — the spec's audit trail. */
    log?: (line: string) => void;
  }) {}

  async open(viewId: string): Promise<MethodResult<"apps.view">> {
    const v = this.d.views.get(viewId);
    if (!v) return { state: "unavailable", reason: "Realm no longer has this view." };
    const row = this.d.servers.get(v.serverId);
    if (!row) return { state: "unavailable", reason: `${v.serverName} is no longer one of your Connections.` };
    if (!this.d.mcp.showsViews(row.id)) return { state: "hidden" };
    const session = this.d.sessions.get(v.sessionId);
    if (!session || !this.d.mcp.effectiveServerIds(session.spaceId).includes(row.id)) {
      return { state: "unavailable", reason: `${row.name} is turned off in this space.` };
    }
    let resource;
    try { resource = await this.d.hub.uiResource(row.id, v.resourceUri); }
    catch (e) { return { state: "unavailable", reason: `${row.name} did not send its view: ${e instanceof Error ? e.message : String(e)}` }; }
    const declared = declaresCsp(resource.ui);
    const csp = approvedCsp(resource.ui?.csp);
    const header = viewCsp(csp, declared);
    this.d.log?.(`[apps] ${row.name} ${v.resourceUri} framed under: ${header}`);
    const { url, origin } = this.d.server.serve({ html: resource.html, csp: header });
    const prefersBorder = typeof resource.ui?.prefersBorder === "boolean" ? resource.ui.prefersBorder : null;
    return {
      state: "ready",
      view: { viewId, sessionId: v.sessionId, serverId: row.id, serverName: row.name, url, origin, tool: v.toolDef, input: v.input, result: v.result, prefersBorder, csp },
    };
  }

  release(url: string): void {
    this.d.server.release(url);
  }

  /**
   * A tool call a view asked for, which the user has just allowed (`apps.callTool`). Only the view's
   * own server is reachable from here — the record names it, not the caller — and only while that
   * server is still showing views at all.
   */
  async callTool(viewId: string, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const v = this.d.views.get(viewId);
    if (!v) throw new RpcError("NOT_FOUND", "Realm no longer has this view.");
    if (!this.d.mcp.showsViews(v.serverId)) throw new RpcError("APP_VIEWS_OFF", `${v.serverName}'s views are switched off.`);
    return await this.d.gateway.callForView(v.sessionId, v.serverId, name, args) as Record<string, unknown>;
  }
}
