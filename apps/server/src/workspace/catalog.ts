import { z } from "zod";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { DelegableModel, Item, LayaMode, McpServer, Skill } from "@realm/contracts";
import type { ProviderCallContext, ProviderCatalogEntry } from "../mcp/gateway";
import { err, ok, parseArgs } from "../mcp/tool-result";
import type { WorkspaceToolGroup } from "./agent-tools";

/**
 * `realm_capabilities`: everything Realm can do for this session, as it stands right now.
 *
 * The preamble (`mcp/capabilities.ts`) names every tool once, at session start, and cannot say more
 * without costing every turn of every session. This is the rest, read when it matters: which groups
 * this space switched off and which this Mac cannot offer, the user's connections and whether each is
 * signed in, the skills and sub-agent models on hand, the panes open — and what Realm does that no
 * tool reaches, so an agent can say where the user does it instead of saying it cannot be done.
 *
 * Nothing here is a list someone keeps by hand. The tool groups and their tools are the gateway's own
 * answer for this session (`McpGateway.catalogFor`), so a tool a provider adds appears here the moment
 * it is listed, in its own words. The one fixed list, `ELSEWHERE`, is of things that are not tools.
 *
 * Read-only, and promptless in every mode: it shows what the Settings and Connections pages show the
 * user, by name, and never a value.
 */
export type CatalogDeps = {
  catalog: (sessionId: string, spaceId: string) => Promise<ProviderCatalogEntry[]>;
  /** The space's MCP server rows, as the Connections page lists them (`McpService.list`). */
  connections: (spaceId: string) => McpServer[];
  skills: (spaceId: string) => { root: string; skills: Skill[] };
  /** What a sub-agent can be put on (`AgentRunService.catalogFor`). */
  models: (sessionId: string) => Promise<{ models: DelegableModel[] }>;
  items: { list(spaceId: string): Item[] };
  laya: () => LayaMode;
};

const CatalogArgs = z.object({ group: z.string().min(1).optional() }).strict();

/** The first sentence of a description: enough to know when to reach for the tool, which is what a
 *  catalog of seventy of them can afford. The whole description is one `group` call away. */
function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const end = flat.search(/[.!?](\s|$)/);
  const sentence = end === -1 ? flat : flat.slice(0, end + 1);
  return sentence.length > 220 ? `${sentence.slice(0, 219)}…` : sentence;
}

/** Why a group lists nothing for this session, in words that say who can change it and where. */
function whyNone(p: ProviderCatalogEntry): string {
  if (!p.enabled) return "off in this space — the user switches it on under \"Realm's own tools\" on the space's Connections page";
  if (p.offered === false) return `this Mac cannot offer it — it needs ${p.needs ?? "something this Mac lacks"}`;
  if (p.offered === null) return "still checking whether this Mac can offer it";
  return "nothing to list in this space (team tools only in a team's space, memory tools only where a memory repo is attached, goal tools only while a goal runs)";
}

function connectionLine(s: McpServer): string {
  if (!s.enabled) return `- ${s.name} — off in this space`;
  const state = s.oauthStatus === "reconnect_needed" ? "needs the user to sign in again on the Connections page"
    : s.status === "connected" ? `connected, ${s.tools.length} tool${s.tools.length === 1 ? "" : "s"} as \`${s.name}__<tool>\``
    : s.status === "error" || s.status === "circuit_open" ? "failing to connect — the Connections page shows why and retries"
    : `on, connects on first use${s.tools.length > 0 ? ` (${s.tools.length} tools last time)` : ""}`;
  return `- ${s.name} — ${state}`;
}

/**
 * What Realm does that no tool reaches, and where the user does it. Said so an agent can hand over
 * the one step that is the user's by naming the place, rather than calling the whole task impossible.
 */
const ELSEWHERE = [
  "Connections page: the user adds MCP servers and signs in to them. You cannot add or sign in to one — name the service and ask them to connect it there; its tools then arrive on the `realm` server.",
  "Settings ▸ Sign-ins: saved passwords and passkeys. `browser_fill_credential` fills them and saves the ones it generates there; nothing reads, edits or deletes one.",
  "Settings ▸ Engines: which agent CLIs are installed and signed in, failover between them, and Laya. A signed-out CLI is `signin_start`.",
  "Settings ▸ Notifications, Usage, Permissions, Computer use, Lab, Keys: the user's. `settings_get` lists the few settings you may change.",
  "Schedules page: the schedules `schedule_create` makes; changing, pausing or deleting one is the user's.",
  "Memory page: the space's and profile's memory documents, which reach you as instructions, and the memory repo.",
  "Code Review, Library, search, checkpoints and history: the user's pages. Your own git and shell tools reach the same repository.",
  "Files: `browser_download` saves into downloads/ of the space's project (or its folder); anything you write into the space folder opens in the Documents pane.",
  "This Mac's own apps (Calendar, Reminders, Contacts, Mail, Messages, Notes): the `mac` command-line tool, when `which mac` finds it, with the `mac` skill.",
];

const TOOLS: Tool[] = [
  {
    name: "realm_capabilities",
    description:
      "Everything Realm can do for you right now: every Realm tool group with what each tool is for, which groups are off in this space or unavailable on this Mac and who can change that, the user's connections (MCP servers) and whether each is signed in, the skills, sub-agent models and panes this space has, and what Realm does that no tool reaches. Call it before telling the user Realm cannot do something, and when a task needs a capability you have not seen. Give `group` (e.g. \"realm-browser\") for that group's tools in full. Read-only.",
    inputSchema: {
      type: "object",
      properties: { group: { type: "string", description: "one tool group, such as realm-browser, for its tools' whole descriptions" } },
      additionalProperties: false,
    },
  },
];

export function createCatalogTools(d: CatalogDeps): WorkspaceToolGroup {
  return { tools: TOOLS, handlers: { realm_capabilities: async (ctx, raw) => capabilities(d, ctx, raw) } };
}

async function capabilities(d: CatalogDeps, ctx: ProviderCallContext, raw: unknown): Promise<CallToolResult> {
  const args = parseArgs(CatalogArgs, raw); if ("error" in args) return args.error;
  const groups = (await d.catalog(ctx.sessionId, ctx.spaceId)).sort((a, b) => a.name.localeCompare(b.name));
  if (args.value.group) {
    const g = groups.find((p) => p.name === args.value.group);
    if (!g) return err(`no tool group "${args.value.group}" — these are: ${groups.map((p) => p.name).join(", ")}`);
    if (g.tools.length === 0) return ok(`${g.name}: ${whyNone(g)}.`);
    return ok([`${g.name} — call each as \`${g.name}__<tool>\`:`, ...g.tools.map((t) => `\n## ${t.name}\n${t.description}`)].join("\n"));
  }

  const lines = [
    "# What Realm can do for this session",
    "",
    "Realm's tools are on the `realm` MCP server as `<group>__<tool>`. `realm_capabilities` with `group` gives a group's tools in full.",
    "",
    "## Tool groups",
  ];
  for (const g of groups.filter((p) => p.tools.length > 0)) {
    lines.push("", `${g.name}:`, ...g.tools.map((t) => `- ${t.name} — ${firstSentence(t.description)}`));
  }
  const none = groups.filter((p) => p.tools.length === 0);
  if (none.length > 0) lines.push("", "Not listed for you:", ...none.map((p) => `- ${p.name} — ${whyNone(p)}`));

  const servers = d.connections(ctx.spaceId);
  lines.push("", "## Connections (the user's MCP servers)");
  lines.push(...(servers.length > 0 ? servers.map(connectionLine) : ["None yet. The user adds them on the Connections page; name the one that would help."]));

  const models = await d.models(ctx.sessionId).then((m) => m.models).catch(() => [] as DelegableModel[]);
  if (models.length > 0) {
    lines.push("", "## Models a sub-agent can run on (`constraints.model`)");
    lines.push(models.map((m) => `${m.label}${m.ready ? "" : " (not ready)"}`).join(", "));
  }

  const { root, skills } = d.skills(ctx.spaceId);
  const on = skills.filter((s) => s.enabled && s.valid);
  lines.push("", `## Skills on in this space (${on.length}; the library is ${root})`);
  lines.push(...(on.length > 0 ? on.map((s) => `- ${s.name} — ${firstSentence(s.description)} (${s.path})`) : ["None."]));

  const counts = new Map<string, number>();
  for (const i of d.items.list(ctx.spaceId)) if (!i.archived) counts.set(i.kind, (counts.get(i.kind) ?? 0) + 1);
  lines.push("", "## Panes in this space");
  lines.push(counts.size > 0 ? `${[...counts].map(([k, n]) => `${n} ${k}`).join(", ")} — \`workspace_state\` lists them with ids and what is on screen.` : "None.");

  lines.push("", `Laya, the on-device model that can find what a computer or simulator step names, is ${d.laya()}.`);
  lines.push("", "## In Realm, with no tool", ...ELSEWHERE.map((l) => `- ${l}`));
  return ok(lines.join("\n"));
}
