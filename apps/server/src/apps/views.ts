import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { newId, type AppViewRef } from "@realm/contracts";
import type { AppViewRecord, AppViewsStore } from "../store/app-views";

/** What the gateway knows the moment a call to a tool with a view comes back. */
export type DrawnView = {
  serverId: string; serverName: string;
  /** The server's name for the tool, and the gateway's (`<server>__<tool>`), which is the one the agent used. */
  tool: string; fullName: string;
  def: Tool; resourceUri: string;
  input: Record<string, unknown>;
  /** The server's result as it came back, before anything was compressed for the agent. */
  result: CallToolResult;
};

type Pending = DrawnView & { viewId: string; at: number };

/** How long a drawn view waits for the agent to report the call it belongs to. A harness reports a
 *  result the moment it has one; anything older than this belongs to a call nobody will report. */
const PENDING_TTL_MS = 10 * 60_000;
/** Bounds on what is held per session while it waits — calls whose results never came (a crash),
 *  views nobody reported. */
const PENDING_MAX = 50;
const CALLS_MAX = 200;
/** The most of a result a view is kept with. Past it the view gets the result's text, and nothing
 *  structured: a payload that size is not a picture, and the row has to stay a row. */
export const VIEW_RESULT_MAX_CHARS = 1_000_000;

/**
 * The views MCP servers draw for tool calls (MCP Apps), from the call that drew one to the tool
 * result that names it.
 *
 * Two parties see one call, and neither sees all of it. The gateway sees it reach a server whose tool
 * has a view — and knows nothing of the agent's id for the call. The agent's harness reports the call
 * and its result — and drops the view. So the gateway tells this registry what it saw (`drew`), the
 * session service tells it each call the agent reports (`noteCall`), and when the agent's result for
 * that call arrives the two are matched (`claim`): the view is stored and the result carries its
 * reference into the transcript.
 *
 * The match is by the name the agent used and the arguments it sent. Claude reports a gateway tool as
 * `mcp__realm__<server>__<tool>` and Codex as `realm.<server>__<tool>`, both ending in the gateway's
 * own name for it; an agent that names it only loosely (an ACP agent's title) still matches when it
 * names the tool and sent exactly these arguments. Nothing else is guessed at: a view Realm cannot
 * place is not drawn under somebody else's call.
 */
export class AppViews {
  private readonly pending = new Map<string, Pending[]>();
  private readonly calls = new Map<string, Map<string, { name: string; input: Record<string, unknown> }>>();

  constructor(private readonly d: { store: AppViewsStore }) {}

  /** The gateway: a call to a tool with a view just came back. */
  drew(sessionId: string, v: DrawnView): void {
    const at = Date.now();
    const list = (this.pending.get(sessionId) ?? []).filter((p) => at - p.at < PENDING_TTL_MS);
    list.push({ ...v, viewId: newId(), at });
    this.pending.set(sessionId, list.slice(-PENDING_MAX));
  }

  /** The session service: the agent reported a call. */
  noteCall(sessionId: string, toolUseId: string, name: string, input: Record<string, unknown>): void {
    const calls = this.calls.get(sessionId) ?? new Map();
    calls.set(toolUseId, { name, input });
    if (calls.size > CALLS_MAX) calls.delete(calls.keys().next().value!);
    this.calls.set(sessionId, calls);
  }

  /**
   * The session service: the agent reported a call's result. The view that call drew, stored and
   * referenced — or null for a call that drew none, which is nearly every call.
   */
  claim(sessionId: string, toolUseId: string): AppViewRef | null {
    const call = this.calls.get(sessionId)?.get(toolUseId);
    if (!call) return null;
    this.calls.get(sessionId)!.delete(toolUseId);
    const list = this.pending.get(sessionId);
    if (!list?.length) return null;
    const scored = list.map((p) => ({ p, how: nameMatch(call.name, p), same: sameJson(call.input, p.input) }));
    const pick = scored.find((s) => s.how === "exact" && s.same) ?? scored.find((s) => s.how === "exact") ?? scored.find((s) => s.how === "loose" && s.same);
    if (!pick) return null;
    list.splice(list.indexOf(pick.p), 1);
    const v = pick.p;
    this.d.store.insert({
      id: v.viewId, sessionId, toolUseId, serverId: v.serverId, serverName: v.serverName, tool: v.tool,
      toolDef: v.def as Record<string, unknown>, resourceUri: v.resourceUri, input: v.input, result: keptResult(v.result),
    });
    return { viewId: v.viewId, serverId: v.serverId, serverName: v.serverName, tool: v.tool };
  }

  get(viewId: string): AppViewRecord | null {
    return this.d.store.get(viewId);
  }

  /** A session went away: whatever it was waiting on goes with it. */
  forget(sessionId: string): void {
    this.pending.delete(sessionId);
    this.calls.delete(sessionId);
  }
}

/** How the agent's name for a call relates to the gateway's name for a tool. */
function nameMatch(agentName: string, p: Pending): "exact" | "loose" | null {
  if (agentName === p.fullName) return "exact";
  for (const sep of ["__", ".", "/", ":", " "]) if (agentName.endsWith(`${sep}${p.fullName}`)) return "exact";
  return agentName.includes(p.tool) ? "loose" : null;
}

/** Whether two argument objects say the same thing, whatever order their keys came in. */
function sameJson(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

/** A result as a view is kept with it — whole, unless it is past `VIEW_RESULT_MAX_CHARS`. */
export function keptResult(r: CallToolResult): Record<string, unknown> {
  const whole = JSON.stringify(r);
  if (whole.length <= VIEW_RESULT_MAX_CHARS) return JSON.parse(whole) as Record<string, unknown>;
  const text = r.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("\n");
  return { content: [{ type: "text", text: text.slice(0, VIEW_RESULT_MAX_CHARS / 2) }], ...(r.isError ? { isError: true } : {}) };
}
