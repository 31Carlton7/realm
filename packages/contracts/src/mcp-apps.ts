import { z } from "zod";

/**
 * MCP Apps (SEP-1865, stable 2026-01-26): the UI an MCP server ships with a tool.
 *
 * A tool names a `ui://` resource in `_meta.ui.resourceUri`; the host reads it with `resources/read`,
 * frames the HTML in a sandbox under a CSP built from the resource's own declared domains, and speaks
 * JSON-RPC to it over postMessage. Realm is the host for every Connection, because Realm is the MCP
 * client for every Connection — whichever agent made the call.
 *
 * These are the parts both processes read: what a tool declares, and the small reference a tool
 * result carries to the view it drew. The view itself never crosses this package.
 */

/** The extension's identifier, advertised under `capabilities.extensions` in `initialize`. */
export const MCP_APPS_EXTENSION = "io.modelcontextprotocol/ui";
/** The one content type the stable spec defines for a view. */
export const MCP_APP_MIME = "text/html;profile=mcp-app";
/** The bridge's protocol version — what `ui/initialize` answers with. */
export const MCP_APPS_PROTOCOL = "2026-01-26";

/**
 * Every view is served on a host of its own under this suffix: `<key>.mcp-view.localhost`, which
 * Chromium resolves to loopback without asking DNS. A fresh key per mounted view makes each one an
 * origin nothing else in the window shares — not Realm's page, not another view, not another copy of
 * the same view — so the browser's own origin rules are what keep them apart. Main recognises a
 * view's frame by this suffix alone; nothing else Realm frames lives under it.
 */
export const APP_VIEW_HOST_SUFFIX = ".mcp-view.localhost";

export function isAppViewHost(hostname: string): boolean {
  return hostname.endsWith(APP_VIEW_HOST_SUFFIX) && hostname.length > APP_VIEW_HOST_SUFFIX.length;
}

/** Whether a URL is a view's — false for anything that does not parse. */
export function isAppViewUrl(url: string): boolean {
  try { return isAppViewHost(new URL(url).hostname); } catch { return false; }
}

/** Who may call a tool. Absent means both — the spec's default. */
export type AppToolVisibility = "model" | "app";

/** What one tool declares about its view: the resource it draws its result in, and who may call it. */
export type ToolUi = { resourceUri: string | null; visibility: AppToolVisibility[] };

const VISIBILITY = new Set<AppToolVisibility>(["model", "app"]);

/**
 * A tool's `_meta`, read for MCP Apps — null when it says nothing about them.
 *
 * Both spellings, because the spec still names the flat `_meta["ui/resourceUri"]` as deprecated rather
 * than gone and servers built against the early drafts send it. A URI that is not `ui://` is no view
 * at all: the scheme is reserved for these resources, and a host that fetched an `https://` one here
 * would be loading a page the spec never let a tool name.
 */
export function toolUiOf(meta: unknown): ToolUi | null {
  if (!meta || typeof meta !== "object") return null;
  const m = meta as Record<string, unknown>;
  const ui = m.ui && typeof m.ui === "object" ? m.ui as Record<string, unknown> : null;
  const legacy = m["ui/resourceUri"];
  if (!ui && legacy === undefined) return null;
  const raw = ui?.resourceUri ?? legacy;
  const resourceUri = typeof raw === "string" && raw.startsWith("ui://") ? raw : null;
  const declared: unknown = ui?.visibility;
  const visibility = Array.isArray(declared)
    ? declared.filter((v): v is AppToolVisibility => typeof v === "string" && VISIBILITY.has(v as AppToolVisibility))
    : ["model", "app"] as AppToolVisibility[];
  return { resourceUri, visibility };
}

/** Whether the agent may see and call a tool. A tool that declares nothing is the agent's. */
export const visibleToModel = (ui: ToolUi | null): boolean => !ui || ui.visibility.includes("model");
/** Whether a view of the same server may call a tool. */
export const callableByApp = (ui: ToolUi | null): boolean => !ui || ui.visibility.includes("app");

/**
 * What a tool result carries when the call drew a view: enough to name it and to ask the server for
 * it, and nothing of the view itself. Optional on `tool_result`, so every result ever written still
 * parses, and so a result from a server whose views are off simply has none.
 */
export const AppViewRefSchema = z.object({
  viewId: z.string(),
  /** The server row the view came from. Survives as a dead id after the row is deleted, and the view
   *  then says its server is gone rather than guessing at another. */
  serverId: z.string(),
  /** The row's name when the call was made — what the view is labelled with. */
  serverName: z.string(),
  /** The server's own name for the tool (`show_chart`), not the gateway's prefixed one. */
  tool: z.string(),
});
export type AppViewRef = z.infer<typeof AppViewRefSchema>;

/** The domains a view's CSP lets it reach, as Realm approved them from what the resource declared. */
export const AppViewCspSchema = z.object({
  connectDomains: z.array(z.string()),
  resourceDomains: z.array(z.string()),
  frameDomains: z.array(z.string()),
  baseUriDomains: z.array(z.string()),
});
export type AppViewCsp = z.infer<typeof AppViewCspSchema>;

/**
 * One view, ready to frame (`apps.view`): the address to load it from and what to tell it once it
 * asks. `input` and `result` are the call's own — the tool's arguments and the server's full
 * `CallToolResult`, before Realm compressed anything for the agent.
 */
export const AppViewSchema = z.object({
  viewId: z.string(),
  sessionId: z.string(),
  serverId: z.string(),
  serverName: z.string(),
  /** The frame's address. Its origin is the view's alone (see `APP_VIEW_HOST_SUFFIX`). */
  url: z.string(),
  origin: z.string(),
  /** The upstream tool definition, for the view's `hostContext.toolInfo`. */
  tool: z.record(z.unknown()),
  input: z.record(z.unknown()),
  result: z.record(z.unknown()),
  /** The resource's `_meta.ui.prefersBorder`; null when it did not say. */
  prefersBorder: z.boolean().nullable(),
  csp: AppViewCspSchema,
});
export type AppView = z.infer<typeof AppViewSchema>;
