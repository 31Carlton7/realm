import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { EFFORT_LEVELS, TEAMMATE_COLORS, TEAMMATE_PERMISSION_MODES, TEAMMATE_SHAPES, TEAM_LIST_TOOL, TEAM_MESSAGE_TOOL, TEAM_SET_ACCESS_TOOL, TEAMMATE_ARCHIVE_TOOL, TEAMMATE_CREATE_TOOL, TEAMMATE_GET_TOOL, TEAMMATE_REORDER_TOOL, TEAMMATE_RUN_CLOCK_TOOL, TEAMMATE_SET_LEAD_TOOL, TEAMMATE_SESSIONS_TOOL, TEAMMATE_UPDATE_TOOL, TEAMMATES_PROVIDER_NAME } from "@realm/contracts";
import type { ProviderCallContext, RealmToolProvider } from "../mcp/gateway";
import { err } from "../mcp/tool-result";
import type { TeammatesStore } from "./store";
import type { TeamManageTools } from "./manage";
import type { TeammatesService } from "./service";

/** The Add a teammate sheet's fields, as `teammate_create` and `teammate_update` take them. */
const TEAMMATE_FIELDS = {
  name: { type: "string", description: "its name, as the Team list shows it" },
  brief: { type: "string", description: "what it does, in the person's words: its chat starts with it" },
  handle: { type: "string", description: "how it is addressed, e.g. \"design-engineer\"; from the name when a new one leaves it out" },
  icon: { type: "object", properties: { shape: { type: "string", enum: [...TEAMMATE_SHAPES] }, color: { type: "string", enum: [...TEAMMATE_COLORS] } }, required: ["shape", "color"], additionalProperties: false },
  agentKind: { type: "string", description: "its engine: \"claude\", \"codex\", \"acp:gemini\"…; Claude when left out" },
  model: { type: ["string", "null"], description: "a model id its engine has, or null for the engine's default" },
  effort: { type: ["string", "null"], enum: [...EFFORT_LEVELS, null], description: "reasoning effort, or null for the default" },
  permissionMode: { type: "string", enum: [...TEAMMATE_PERMISSION_MODES], description: "its access, never more than yours: \"default\" (Ask each time), \"acceptEdits\", \"bypassPermissions\" (Full access), \"plan\" or \"ask\"" },
  folder: { type: ["string", "null"], description: "where it works: an absolute folder or one under ~/; null for the space's own" },
  lead: { type: "boolean", description: "make it the space's Lead" },
  group: { type: ["string", "null"], description: "the Team list section it sits in, or null for the top" },
  schedule: {
    type: ["object", "null"], description: "its clock: a cron, what it says when it fires, and whether it is on; null removes it",
    properties: { cron: { type: "string" }, prompt: { type: "string" }, enabled: { type: "boolean" } }, additionalProperties: false,
  },
};

const TOOLS: Tool[] = [
  {
    name: TEAM_LIST_TOOL,
    description: [
      "The teammates in this space: each one's handle, what it does, whether it is the Lead, whether it is idle, working or needs the person, the task it is on, and its model. Read-only.",
      "Under each, how it is set up: its id, engine and model id, effort, access, folder, group, clock (cron, next run or paused), and its chat's session id. `archived: true` lists the archived teammates instead.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: { archived: { type: "boolean", description: "list the archived teammates instead of the current ones" } },
      additionalProperties: false,
    },
  },
  {
    name: TEAMMATE_GET_TOOL,
    description: "One teammate in full: how it is set up, its whole brief, what its clock says, and its newest task sessions. Finds archived teammates too. Read-only.",
    inputSchema: {
      type: "object",
      properties: { to: { type: "string", description: "its handle, e.g. \"cto\", or \"lead\"" } },
      required: ["to"],
      additionalProperties: false,
    },
  },
  {
    name: TEAMMATE_SESSIONS_TOOL,
    description: "The task sessions a teammate started, newest first: each one's title, session id, state, when it was last active, and what came of it (a PR, a release, a failure). session_read reads one. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "its handle, e.g. \"cto\", or \"lead\"" },
        limit: { type: "number", description: "how many, newest first (default 20)" },
      },
      required: ["to"],
      additionalProperties: false,
    },
  },
  {
    name: TEAMMATE_CREATE_TOOL,
    description: [
      "Add a teammate to this space when the person asks: its name and brief, and any of its engine, model, effort, access, folder, group, Lead and clock.",
      "Only the space's Lead in its own chat, or one of the person's own sessions, and only in a turn the person started. You cannot give it more access than you have.",
      "The person approves it on a card unless you are on Full access. Answers with its id, handle, folder and chat.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: TEAMMATE_FIELDS,
      required: ["name", "brief"],
      additionalProperties: false,
    },
  },
  {
    name: TEAMMATE_UPDATE_TOOL,
    description: [
      "Change a teammate when the person asks: any of its name, handle, brief, icon, engine, model, effort, access, folder, group, Lead and clock. Fields left out keep their value.",
      "The same rules as teammate_create. A change that lowers its model or effort always asks the person on a card, even on Full access, saying from what to what.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "its handle, e.g. \"scout\", or \"lead\"" },
        ...TEAMMATE_FIELDS,
      },
      required: ["to"],
      additionalProperties: false,
    },
  },
  {
    name: TEAMMATE_ARCHIVE_TOOL,
    description: [
      "Archive a teammate when the person asks: it leaves the Team list and the team tools, an archived Lead leaves the space with none, and its clock stops. Its sessions stay. `archived: false` brings it back.",
      "The same rules as teammate_create: the Lead in its own chat or one of the person's sessions, in a turn the person started, on a card unless you are on Full access.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "its handle, e.g. \"scout\"; archived teammates are found too" },
        archived: { type: "boolean", description: "false brings an archived teammate back; true when left out" },
      },
      required: ["to"],
      additionalProperties: false,
    },
  },
  {
    name: TEAMMATE_SET_LEAD_TOOL,
    description: [
      "Make a teammate the space's Lead when the person asks, or leave the space with none (`to: null`).",
      "Only the Lead in its own chat or one of the person's sessions, in a turn the person started: a teammate cannot make itself the Lead. On a card unless you are on Full access.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: { to: { type: ["string", "null"], description: "its handle, e.g. \"cto\", or null for no Lead" } },
      required: ["to"],
      additionalProperties: false,
    },
  },
  {
    name: TEAMMATE_REORDER_TOOL,
    description: [
      "Set the Team list's order and sections when the person asks: every teammate on it, top to bottom, each with the section it sits in (none for the top).",
      "The Lead in its own chat or one of the person's sessions, in a turn the person started. No card: it only moves rows.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        order: {
          type: "array", description: "every teammate on the Team list, top to bottom",
          items: {
            type: "object",
            properties: { handle: { type: "string" }, group: { type: ["string", "null"], description: "its section, or null for the top" } },
            required: ["handle"], additionalProperties: false,
          },
        },
      },
      required: ["order"],
      additionalProperties: false,
    },
  },
  {
    name: TEAMMATE_RUN_CLOCK_TOOL,
    description: [
      "Fire a teammate's clock now, as Run now on its page does: its clock's prompt becomes a turn in its chat, and its next scheduled run stays where it was.",
      "The Lead in its own chat or one of the person's sessions, in a turn the person started, on a card unless you are on Full access.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: { to: { type: "string", description: "its handle, e.g. \"polish\"" } },
      required: ["to"],
      additionalProperties: false,
    },
  },
  {
    name: TEAM_MESSAGE_TOOL,
    description: [
      "Message a teammate: your message becomes a turn in its own chat, marked as from you, after the turn it is on. Use it to ask a teammate something or to hand it work that is its to do.",
      "`to` is its handle (\"cto\" or \"@cto\"), or \"lead\" for the space's Lead. Without `wait` you go on at once, and it answers in its own chat (or messages you back).",
      "With `wait: true` this call holds until it has answered and returns its reply — only when you cannot go on without it. Waiting on yourself, or on a teammate that is waiting on you, is refused.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "a teammate's handle, e.g. \"cto\", or \"lead\"" },
        message: { type: "string", description: "what you want, in plain words, with what it needs to know" },
        wait: { type: "boolean", description: "hold until it answers, and return the answer" },
      },
      required: ["to", "message"],
      additionalProperties: false,
    },
  },
  {
    name: TEAM_SET_ACCESS_TOOL,
    description: [
      "Set a teammate's access (its permission mode, for its chat and its task sessions) when the person asks you to. Only the space's Lead, in its own chat, can use it, and only in a turn the person started:",
      "a turn started by a teammate's message, a schedule, another session or Realm is refused. You cannot give more access than you have now, yourself included, and the read-only modes are not set here.",
      "Each change writes a line in your chat and in the teammate's saying what you changed, with an Undo for the person. A refused call changes nothing and says why.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "a teammate's handle, e.g. \"polish\", or \"lead\" for yourself" },
        mode: { type: "string", enum: ["default", "acceptEdits", "bypassPermissions"], description: "\"default\" (Ask each time), \"acceptEdits\" (Accept edits) or \"bypassPermissions\" (Full access)" },
      },
      required: ["to", "mode"],
      additionalProperties: false,
    },
  },
];

/**
 * The `realm-team` provider: `team_list`, `teammate_get`, `teammate_sessions`, `teammate_create`, `teammate_update`,
 * `teammate_archive`, `teammate_set_lead`, `teammate_reorder`, `teammate_run_clock`, `team_message` and `team_set_access`, in every session of a
 * space that has teammates — theirs and the person's own, so "ask @cto" works from anywhere in the
 * space. `team_set_access` refuses every caller but the Lead in a turn the person started.
 */
export function createTeammatesProvider(d: {
  store: Pick<TeammatesStore, "hasAny">;
  teammates: Pick<TeammatesService, "teamList" | "teammateGet" | "teammateSessions" | "teamMessage" | "teamSetAccess">;
  manage: Pick<TeamManageTools, "create" | "update" | "archive" | "setLead" | "reorder" | "runClock">;
  mcp: { providerEnabled(spaceId: string, name: string): boolean };
}): RealmToolProvider {
  return {
    name: TEAMMATES_PROVIDER_NAME,
    listsIn: (spaceId) => d.store.hasAny(spaceId),
    async tools(ctx: ProviderCallContext): Promise<Tool[]> {
      return d.mcp.providerEnabled(ctx.spaceId, TEAMMATES_PROVIDER_NAME) && d.store.hasAny(ctx.spaceId) ? TOOLS : [];
    },
    async call(ctx: ProviderCallContext, tool: string, args: unknown): Promise<CallToolResult> {
      if (!d.mcp.providerEnabled(ctx.spaceId, TEAMMATES_PROVIDER_NAME))
        return err(`the ${TEAMMATES_PROVIDER_NAME} tools are off for this space — mcp.setProviderEnabled turns them back on.`);
      try {
        switch (tool) {
          case TEAM_LIST_TOOL: return d.teammates.teamList(ctx, args);
          case TEAMMATE_GET_TOOL: return d.teammates.teammateGet(ctx, args);
          case TEAMMATE_SESSIONS_TOOL: return d.teammates.teammateSessions(ctx, args);
          case TEAMMATE_CREATE_TOOL: return await d.manage.create(ctx, args);
          case TEAMMATE_UPDATE_TOOL: return await d.manage.update(ctx, args);
          case TEAMMATE_ARCHIVE_TOOL: return await d.manage.archive(ctx, args);
          case TEAMMATE_SET_LEAD_TOOL: return await d.manage.setLead(ctx, args);
          case TEAMMATE_REORDER_TOOL: return await d.manage.reorder(ctx, args);
          case TEAMMATE_RUN_CLOCK_TOOL: return await d.manage.runClock(ctx, args);
          case TEAM_MESSAGE_TOOL: return await d.teammates.teamMessage(ctx, args);
          case TEAM_SET_ACCESS_TOOL: return await d.teammates.teamSetAccess(ctx, args);
          default: return err(`unknown tool "${tool}" — this provider has: ${TOOLS.map((t) => t.name).join(", ")}`);
        }
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  };
}
