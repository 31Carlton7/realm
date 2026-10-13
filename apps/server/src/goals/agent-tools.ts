import { z } from "zod";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { GOAL_PROVIDER_NAME, GOAL_STATUS_TOOL_NAME, UPDATE_GOAL_TOOL_NAME } from "@realm/contracts";
import type { ProviderCallContext, RealmToolProvider } from "../mcp/gateway";
import type { GoalService } from "./service";

/**
 * The two tools a session pursuing a goal can reach: what am I doing, and I am finished.
 *
 * They exist for one reason — the agent is the only thing that can know the objective is met, and
 * without a way to say so a goal would run until its budget ran out.
 *
 * They are listed on EVERY session, goal or not. They used to appear only while a goal was active,
 * and that made them unreachable in the common case: an agent reads its tool list when it connects,
 * a `/goal` typed mid-conversation arrives after that, and an engine that does not re-list on
 * `tools/list_changed` (or one that was never told) never sees `update_goal` at all — the goal then
 * continues itself, turn after turn, past done. A tool that is always there and refuses without a
 * goal is a smaller risk than a goal nobody can close; the description says when to call it.
 *
 * `update_goal` is deliberately narrow. It cannot start a goal, cannot change the objective, and
 * cannot pause — those are the user's, and an agent that could rewrite its own objective is an agent
 * that can declare victory by lowering the bar. The two statuses it can set are the two conclusions
 * only the work can reach.
 */
export { GOAL_PROVIDER_NAME, GOAL_STATUS_TOOL_NAME, UPDATE_GOAL_TOOL_NAME };

const UpdateArgs = z.object({
  status: z.enum(["complete", "blocked"]),
  /** What was finished, or what is in the way. Shown to the user as the goal's last word, so it is
   *  required: a goal that stopped with no reason given is the state this whole mode exists to
   *  avoid. */
  note: z.string().min(1).max(2_000),
/* Strict, so the advertised `additionalProperties: false` is a rule rather than a suggestion. A
   model that sends `objective` here is trying to rewrite what it is being measured against, and
   quietly dropping the field would answer that attempt with a success. */
}).strict();

const ok = (text: string): CallToolResult => ({ content: [{ type: "text", text }], isError: false });
const err = (text: string): CallToolResult => ({ content: [{ type: "text", text }], isError: true });

const UPDATE_GOAL_TOOL: Tool = {
  name: UPDATE_GOAL_TOOL_NAME,
  description: [
    "End the goal this session is pursuing. Only call this when Realm has told you that you are pursuing a goal; without one it is refused.",
    "Call with `complete` only when every requirement of the objective is met and you can point at the evidence — not because the work is mostly done, not because a summary reads well, and never because the budget is nearly spent.",
    "Call with `blocked` only when the same obstacle has stopped you on three turns in a row and there is no safe action left to take. The first time something fails, work around it instead.",
    "Until you call this, the session keeps taking turns on the objective by itself.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["complete", "blocked"], description: "`complete` when the objective is met; `blocked` when the same obstacle has stopped three consecutive turns." },
      note: { type: "string", description: "One or two sentences for the person: what was achieved, or what is in the way." },
    },
    required: ["status", "note"],
    additionalProperties: false,
  },
};

const GOAL_STATUS_TOOL: Tool = {
  name: GOAL_STATUS_TOOL_NAME,
  description: "The objective this session is pursuing, how many turns it has taken on it, and what is left of its token budget. Refused when the session has no goal running.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

export function createGoalProvider(deps: {
  goals: GoalService;
  mcp: { providerEnabled(spaceId: string, name: string): boolean };
}): RealmToolProvider {
  const live = (sessionId: string) => {
    const goal = deps.goals.get(sessionId);
    return goal && goal.status === "active" ? goal : null;
  };
  return {
    name: GOAL_PROVIDER_NAME,
    async tools(ctx: ProviderCallContext): Promise<Tool[]> {
      return deps.mcp.providerEnabled(ctx.spaceId, GOAL_PROVIDER_NAME) ? [UPDATE_GOAL_TOOL, GOAL_STATUS_TOOL] : [];
    },
    async call(ctx: ProviderCallContext, tool: string, args: unknown): Promise<CallToolResult> {
      if (!deps.mcp.providerEnabled(ctx.spaceId, GOAL_PROVIDER_NAME))
        return err(`the ${GOAL_PROVIDER_NAME} tools are disabled for this space — mcp.setProviderEnabled turns them back on.`);
      const goal = live(ctx.sessionId);
      // Refused rather than answered emptily: a model that gets "there is no goal" back from
      // `update_goal` has just been told its objective evaporated, which is worth an error.
      if (!goal) return err("this session is not pursuing a goal, so there is nothing to update. Realm says so in the prompt when one is running.");
      if (tool === GOAL_STATUS_TOOL_NAME) {
        const budget = goal.tokenBudget === null
          ? "no token budget"
          : `${Math.max(0, goal.tokenBudget - goal.tokensUsed).toLocaleString("en-US")} of ${goal.tokenBudget.toLocaleString("en-US")} tokens left`;
        return ok([`Objective: ${goal.objective}`, `Turns so far: ${goal.turns}`, `Tokens used: ${goal.tokensUsed.toLocaleString("en-US")} (${budget})`].join("\n"));
      }
      if (tool !== UPDATE_GOAL_TOOL_NAME) return err(`unknown tool: ${tool}`);
      const parsed = UpdateArgs.safeParse(args);
      if (!parsed.success) return err(`bad arguments: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
      const next = deps.goals.set(ctx.sessionId, parsed.data.status, parsed.data.note);
      return ok(next.status === "complete"
        ? `Goal marked complete after ${next.turns} turn${next.turns === 1 ? "" : "s"}. The session will not continue it again.`
        : `Goal marked blocked after ${next.turns} turn${next.turns === 1 ? "" : "s"}. It stays on the session for the user to resume.`);
    },
  };
}
