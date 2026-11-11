import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { TEAM_LIST_TOOL, TEAM_MESSAGE_TOOL, TEAM_SET_ACCESS_TOOL, TEAMMATES_PROVIDER_NAME } from "@realm/contracts";
import type { ProviderCallContext, RealmToolProvider } from "../mcp/gateway";
import { err } from "../mcp/tool-result";
import type { TeammatesStore } from "./store";
import type { TeammatesService } from "./service";

const TOOLS: Tool[] = [
  {
    name: TEAM_LIST_TOOL,
    description: "The teammates in this space: each one's handle, what it does, whether it is the Lead, whether it is idle, working or needs the person, the task it is on, and its model. Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
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
 * The `realm-team` provider: `team_list`, `team_message` and `team_set_access`, in every session of a
 * space that has teammates — theirs and the person's own, so "ask @cto" works from anywhere in the
 * space. `team_set_access` refuses every caller but the Lead in a turn the person started.
 */
export function createTeammatesProvider(d: {
  store: Pick<TeammatesStore, "hasAny">;
  teammates: Pick<TeammatesService, "teamList" | "teamMessage" | "teamSetAccess">;
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
          case TEAM_LIST_TOOL: return d.teammates.teamList(ctx);
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
