import { z } from "zod";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { AGENT_META, findLeafOfItem, parseStoredView, viewSettingKey, type AgentKind, type Session, type Space } from "@realm/contracts";
import type { ProviderCallContext } from "../mcp/gateway";
import { clip, err, ok, parseArgs } from "../mcp/tool-result";
import type { BrowserPermissionBroker } from "../browsers/permissions";
import type { ModelResolution } from "../delegation/models";
import type { RpcServer } from "../rpc/server";
import type { ItemsStore } from "../store/items";
import type { SendMessage } from "../sessions/service";
import type { WorkspaceToolGroup } from "./agent-tools";

/**
 * `session_open`: a new session the USER will work in, put on screen beside the agent that asked.
 *
 * ## Not delegation
 *
 * `agent_run` / `agent_start` hand a task to a sub-agent: the child has no pane, is listed under its
 * lead, and its result comes back to the caller as a report. `session_open` is none of that. It opens
 * an ordinary session — a pane of its own in the layout, the same row in the sidebar any session has —
 * and the caller hears nothing back from it. What happens there is between the user and that agent,
 * which is why it is gated like an action of the caller's own, and why it takes the caller's place
 * in the delegation rules rather than a child's: a delegated agent may not open one at all.
 *
 * ## The mode it starts in
 *
 * The lower of two: what a session the user opens gets (their default for new sessions), and the
 * caller's own mode. Never more than either — one approved card must not turn an agent that asks
 * before each action into a session that asks before none.
 */
export type SessionOpenDeps = {
  sessions: {
    get(id: string): Session;
    create(input: { spaceId: string; agentKind: AgentKind; projectId: string | null; environmentId: string; model: string | null; effort: string | null; permissionMode: string; title: string; dispatchedBy: { sessionId: string; kind: "session_open" } }): { session: Session; itemId: string };
    send(id: string, msg: SendMessage): Promise<void>;
  };
  items: Pick<ItemsStore, "findByRefId">;
  spaces: { get(id: string): Space | null };
  settings: { get(key: string): unknown };
  broker: Pick<BrowserPermissionBroker, "gate">;
  rpc: Pick<RpcServer, "broadcast">;
  /** The user's default mode for a new session of this kind — `sessions.create`'s own resolution. */
  defaultMode(kind: AgentKind): string;
  /** A model named the way a person would — the delegation tools' resolver. */
  placeModel(caller: Session, model: string | undefined): Promise<ModelResolution>;
  /** A delegated child: it reports to its lead, and opening sessions the user must look after is not its call. */
  delegated: { isChild(sessionId: string): boolean };
};

const PROMPT_MAX = 20_000;
const SessionOpenArgs = z.object({
  prompt: z.string().trim().min(1).max(PROMPT_MAX).optional(),
  beside: z.enum(["right", "below"]).default("right"),
  model: z.string().trim().min(1).max(120).optional(),
}).strict();

/** More restrictive = lower; an unknown mode counts as `default`, so the cap errs toward asking. */
const MODE_RANK: Record<string, number> = { plan: 0, ask: 0, default: 1, acceptEdits: 2, bypassPermissions: 3 };
const rank = (mode: string): number => MODE_RANK[mode] ?? 1;
export const capMode = (userDefault: string, caller: string): string => (rank(caller) < rank(userDefault) ? caller : userDefault);

const TOOL: Tool = {
  name: "session_open",
  description:
    "Open a new agent session the user will work in, as its own pane beside yours in this space — for when the user asks for a second session next to this one (\"open a session beside me that…\"), or work should continue where they can talk to it directly. Give `prompt` to send it a first message (it reads as sent by you), `beside` to put it to the right (default) or below, and `model` to name another model the way a person would. It is NOT delegation: you get no report back and cannot wait for it — use agent_run or agent_start when you want a result returned to you. Starts in your working directory, in no more permissive a mode than yours. Asks the user for permission unless you are in Full access.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "the new session's first message; omit to open it empty for the user to type in" },
      beside: { type: "string", enum: ["right", "below"], description: "where the pane goes relative to yours (default right)" },
      model: { type: "string", description: "which model, named as a person would (\"Opus\", \"GPT-6\"); default: yours" },
    },
    additionalProperties: false,
  },
};

export function createSessionOpenTools(d: SessionOpenDeps): WorkspaceToolGroup {
  return { tools: [TOOL], handlers: { session_open: (ctx, raw) => open(d, ctx, raw) } };
}

async function open(d: SessionOpenDeps, ctx: ProviderCallContext, raw: unknown): Promise<CallToolResult> {
  const args = parseArgs(SessionOpenArgs, raw); if ("error" in args) return args.error;
  const { prompt, beside, model } = args.value;
  if (d.delegated.isChild(ctx.sessionId))
    return err("refused: a delegated agent may not open sessions — report back to the session that delegated to you, and it can open one.");
  const caller = d.sessions.get(ctx.sessionId);

  const placed = await d.placeModel(caller, model);
  if (!placed.ok) return err(placed.message);
  const { kind, model: modelId, label } = placed.choice;
  const permissionMode = capMode(d.defaultMode(kind), caller.permissionMode);
  const edge = beside === "below" ? "bottom" : "right";

  const on = `${AGENT_META[kind].label} · ${label}`;
  const title = prompt ? `Open a ${on} session ${beside === "below" ? "below" : "beside"} this one: "${clip(prompt.replace(/\s+/g, " "), 100)}"` : `Open an empty ${on} session ${beside === "below" ? "below" : "beside"} this one`;
  const gate = await d.broker.gate(ctx.sessionId, "session_open", title, { ...(prompt ? { prompt } : {}), ...(model ? { model } : {}), beside });
  if (!gate.allowed) return err(gate.reason);

  let created;
  try {
    created = d.sessions.create({
      spaceId: ctx.spaceId, agentKind: kind, projectId: caller.projectId, environmentId: caller.environmentId, model: modelId, effort: null,
      permissionMode, title: prompt ? firstLine(prompt) : "", dispatchedBy: { sessionId: ctx.sessionId, kind: "session_open" },
    });
  } catch (e) {
    return err(`could not open the session: ${e instanceof Error ? e.message : String(e)}`);
  }
  const { session, itemId } = created;
  d.rpc.broadcast("session.openRequested", { spaceId: ctx.spaceId, sessionId: session.id, itemId, openedBy: ctx.sessionId, edge });

  if (prompt) {
    try {
      await d.sessions.send(session.id, { text: prompt, attachments: [], from: { sessionId: caller.id, title: caller.title } });
    } catch (e) {
      return err(`opened session ${session.id}, but its first message did not go: ${e instanceof Error ? e.message : String(e)}. The user can type it there.`);
    }
  }
  const where = callerOnScreen(d, ctx, caller) ? `in a pane ${beside === "below" ? "below" : "beside"} yours` : "in the sidebar — your session is not on screen, so its pane waits there for the user";
  const mode = permissionMode === caller.permissionMode ? "" : ` It starts in ${permissionMode} mode, the user's default for a new session.`;
  return ok(`Opened session ${session.id} (${on}) ${where}.${prompt ? " It has your prompt and is working on it." : " It is empty, waiting for the user."}${mode} It will not report back to you; session_read reads its transcript.`);
}

/** The first line of the prompt, collapsed — the session's title until the title generator names it. */
function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  return clip(line.replace(/\s+/g, " ").trim(), 40);
}

/** Whether the caller's pane is in the window's saved layout — where "beside you" has a meaning. */
function callerOnScreen(d: SessionOpenDeps, ctx: ProviderCallContext, caller: Session): boolean {
  const space = d.spaces.get(ctx.spaceId);
  const item = d.items.findByRefId(caller.id);
  if (!space || !item) return false;
  const view = parseStoredView(d.settings.get(viewSettingKey(space.profileId)));
  return !!view && !!findLeafOfItem(view.layout, item.id);
}
