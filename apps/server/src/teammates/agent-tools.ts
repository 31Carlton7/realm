import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { TEAM_LIST_TOOL, TEAM_MESSAGE_TOOL, TEAMMATES_PROVIDER_NAME } from "@realm/contracts";
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
];

/**
 * The `realm-team` provider: `team_list` and `team_message`, in every session of a space that has
 * teammates — theirs and the person's own, so "ask @cto" works from anywhere in the space.
 */
export function createTeammatesProvider(d: {
  store: Pick<TeammatesStore, "hasAny">;
  teammates: Pick<TeammatesService, "teamList" | "teamMessage">;
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
          default: return err(`unknown tool "${tool}" — this provider has: ${TOOLS.map((t) => t.name).join(", ")}`);
        }
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  };
}
