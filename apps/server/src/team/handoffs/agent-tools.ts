import { z } from "zod";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { TEAM_HANDOFF_TOOL, TEAM_MENTION_TOOL } from "@realm/contracts";
import type { ProviderCallContext } from "../../mcp/gateway";
import { err, ok, parseArgs } from "../../mcp/tool-result";
import type { TeamStore } from "../store";
import type { HandoffService } from "./service";

const HandoffArgs = z.object({
  to: z.string().trim().min(1).max(60),
  note: z.string().trim().min(1).max(4_000),
  record: z.string().min(1).max(200).optional(),
  files: z.array(z.string().min(1).max(1_000)).max(40).optional(),
}).strict();

const MentionArgs = z.object({
  role: z.string().trim().min(1).max(60),
  task: z.string().trim().min(1).max(8_000),
}).strict();

export const HANDOFF_TOOLS: Tool[] = [
  {
    name: TEAM_HANDOFF_TOOL,
    description: [
      "Hand part of your work to another role on this team, which wakes it as a run of its own. Only a role's run can hand off, and only to the roles its page names (team_roles shows who).",
      "`to` is the role's name; `note` says what is done and what is left for it; `record` is the creator's record it is about (creators/<name>.md); `files` are paths in this space's folder it should use.",
      "You do not wait for it: hand off, say so in your report, and finish. A second handoff to the same role about the same record while it is still on the first starts nothing.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "the receiving role's name, e.g. \"Creator Manager\"" },
        note: { type: "string", description: "what you did and what it should do next" },
        record: { type: "string", description: "creators/<name>.md, or <name>" },
        files: { type: "array", items: { type: "string" }, description: "paths inside this space's folder" },
      },
      required: ["to", "note"],
      additionalProperties: false,
    },
  },
  {
    name: TEAM_MENTION_TOOL,
    description: [
      "Ask a role on this team for something now, as your sub-agent: it starts on its own brief and model with your `task`, in your Agents tab, and you collect its answer with agent_wait like any sub-agent.",
      "For a question you need answered in this turn. To pass work on and move on, a role's run uses team_handoff instead.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        role: { type: "string", description: "the role's name, e.g. \"Creator Manager\"" },
        task: { type: "string", description: "what you need from it" },
      },
      required: ["role", "task"],
      additionalProperties: false,
    },
  },
];

/** The two Phase 4 tools of the `realm-team` provider: listed and refused on the provider's terms. */
export function createHandoffTools(d: { handoffs: Pick<HandoffService, "handoff" | "mention">; teamStore: Pick<TeamStore, "roleByName"> }) {
  return {
    tools: HANDOFF_TOOLS,
    async call(ctx: ProviderCallContext, tool: string, args: unknown): Promise<CallToolResult | null> {
      if (tool === TEAM_HANDOFF_TOOL) {
        const a = parseArgs(HandoffArgs, args); if ("error" in a) return a.error;
        const out = d.handoffs.handoff(ctx, a.value);
        return ok(out.started
          ? `Handed off to ${out.toName} (handoff ${out.handoff.id}); it wakes as a run of its own${out.handoff.state === "queued" ? " when a slot is free" : ""}. You do not wait for it — finish your report.`
          : `${out.toName} is already working on this from an earlier handoff (handoff ${out.handoff.id}); nothing new started. Say so in your report.`);
      }
      if (tool === TEAM_MENTION_TOOL) {
        const a = parseArgs(MentionArgs, args); if ("error" in a) return a.error;
        const role = d.teamStore.roleByName(ctx.spaceId, a.value.role);
        if (!role) return err(`this team has no role called ${a.value.role} — team_roles lists them`);
        const out = await d.handoffs.mention(ctx, role.id, a.value.task, "session");
        return out.ok
          ? ok(`Started ${role.name} as your sub-agent (handle ${out.childId}). Collect its answer with agent_wait.`)
          : err(`${role.name} was not started: ${out.why}`);
      }
      return null;
    },
  };
}
