import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  AGENT_MODELS, EFFORT_LEVELS, TeammateCreateArgsSchema, TeammateUpdateArgsSchema, normalizeHandle, teammateByHandle,
  type AgentKind, type Session, type Teammate,
} from "@realm/contracts";
import type { ProbeResult } from "@realm/adapters";
import type { BrowserPermissionBroker } from "../browsers/permissions";
import { modeLabel, rank } from "../delegation/dispatch";
import { askCard, refuseUnlessPersonTurn, type AgentWriteRule } from "../mcp/agent-gate";
import type { ProviderCallContext } from "../mcp/gateway";
import { err, ok, parseArgs } from "../mcp/tool-result";
import { modelNameOf } from "../sessions/handover";
import { RpcError } from "../store/rows";
import { pickFolder } from "../workspace/spaces";
import type { TeammatesService } from "./service";

/**
 * The tools that change the Team itself: `teammate_create` and `teammate_update`. They wrap the
 * service's `create` and `update`, which the Add a teammate and Edit sheets call, behind the gates
 * every agent write to Realm keeps:
 *
 * - the caller is the space's Lead in its own chat, or a session of the person's (not a teammate's
 *   task session, nor another teammate's chat);
 * - the person started this turn (`refuseUnlessPersonTurn`);
 * - no teammate is put on more access than the caller has (`rank`, as `team_set_access`);
 * - a folder is taken the way `space_create` takes one (`pickFolder`);
 * - a card, unless the caller is on Full access; and a card that shows even on Full access when the
 *   change lowers a teammate's model or effort, saying from what to what.
 */
export type TeamManageDeps = {
  team: Pick<TeammatesService, "create" | "update" | "get" | "list" | "turnOrigin" | "teammateOf">;
  sessions: { get(id: string): Session; personStartedTurn(id: string): boolean; probeCached(): { rows: ProbeResult[] } | null };
  broker: Pick<BrowserPermissionBroker, "gate">;
  /** The mode a new session on `kind` starts in when nobody named one (Settings' default). */
  defaultMode: (kind: AgentKind) => string;
  userHome: string;
  realmHome: string;
};

/** Who is calling, and the most access it can hand on: the session's mode, and the Lead's own when it is lower. */
type Caller = { session: Session; lead: Teammate | null; held: string };

export class TeamManageTools {
  constructor(private readonly d: TeamManageDeps) {}

  async create(ctx: ProviderCallContext, raw: unknown): Promise<CallToolResult> {
    const a = parseArgs(TeammateCreateArgsSchema, raw); if ("error" in a) return a.error;
    const nothing = "Nothing was made.";
    const caller = this.caller(ctx, "add a teammate", nothing); if ("error" in caller) return caller.error;
    const turn = this.personTurn(caller, { rule: "Teammates are added", nothing }); if (turn) return turn;
    const input = a.value;
    const agentKind = input.agentKind ?? "claude";
    const wanted = input.permissionMode ?? this.d.defaultMode(agentKind);
    const capped = this.capped(caller, wanted, input.name, nothing); if (capped) return capped;
    let folder: string | undefined;
    if (input.folder) {
      const picked = pickFolder(this.d, input.folder);
      if ("error" in picked) return err(`${picked.error} ${nothing}`);
      folder = picked.path;
    }
    const model = modelNameOf(agentKind, input.model ?? null, this.probes());
    const title = `Add a teammate, ${input.name}${input.handle ? ` (@${normalizeHandle(input.handle)})` : ""}: ${model}, ${modeLabel(wanted)}${folder ? `, working in ${folder}` : ""}${input.lead ? ", as the Lead" : ""}${input.schedule?.cron ? `, on a clock ("${input.schedule.cron}")` : ""}`;
    const denied = await askCard(this.d.broker, ctx.sessionId, { toolKey: "teammate_create", title, input: { ...input, ...(folder ? { folder } : {}), permissionMode: wanted } });
    if (denied) return denied;
    let made: Teammate;
    try {
      made = this.d.team.create({ ...input, spaceId: caller.session.spaceId, agentKind, permissionMode: wanted as Teammate["permissionMode"], ...(folder ? { folder } : {}) });
    } catch (e) {
      return err(`${e instanceof RpcError ? e.message : String(e)}. ${nothing}`);
    }
    return ok(`Added @${made.handle} (${made.name}) — id ${made.id}, on ${modelNameOf(made.agentKind, made.model, this.probes())}, ${modeLabel(made.permissionMode)}, working in ${made.folder}. Its chat is session ${made.homeSessionId ?? "not made yet"}. team_message reaches it; teammate_get reads it back.`);
  }

  async update(ctx: ProviderCallContext, raw: unknown): Promise<CallToolResult> {
    const a = parseArgs(TeammateUpdateArgsSchema, raw); if ("error" in a) return a.error;
    const nothing = "Nothing changed.";
    const caller = this.caller(ctx, "edit a teammate", nothing); if ("error" in caller) return caller.error;
    const turn = this.personTurn(caller, { rule: "Teammates are edited", nothing }); if (turn) return turn;
    const { to, ...change } = a.value;
    const target = teammateByHandle(this.d.team.list(caller.session.spaceId), to);
    if (!target) return err(`there is no @${normalizeHandle(to)} here. Teammates here: ${this.d.team.list(caller.session.spaceId).map((t) => `@${t.handle}`).join(", ") || "none"}. ${nothing}`);
    if (Object.keys(change).length === 0) return err(`name at least one thing to change. ${nothing}`);
    if (change.permissionMode !== undefined && change.permissionMode !== target.permissionMode) {
      const capped = this.capped(caller, change.permissionMode, `@${target.handle}`, nothing); if (capped) return capped;
    }
    let folder: string | null | undefined = change.folder;
    if (change.folder) {
      const picked = pickFolder(this.d, change.folder);
      if ("error" in picked) return err(`${picked.error} ${nothing}`);
      folder = picked.path;
    }
    const lowered = this.lowered(target, change);
    const said = describe(target, { ...change, ...(folder !== undefined ? { folder } : {}) }, this.probes());
    const title = `Change @${target.handle}: ${said.join("; ")}`;
    const denied = await askCard(this.d.broker, ctx.sessionId, {
      toolKey: "teammate_update", title: lowered.length > 0 ? `${title} — this LOWERS its ${lowered.join(" and ")}` : title,
      input: { to: target.handle, ...change, ...(folder !== undefined ? { folder } : {}) }, always: lowered.length > 0,
    });
    if (denied) return denied;
    try {
      this.d.team.update({ id: target.id, ...change, ...(folder !== undefined ? { folder } : {}) });
    } catch (e) {
      return err(`${e instanceof RpcError ? e.message : String(e)}. ${nothing}`);
    }
    const now = this.d.team.get(target.id);
    return ok(`Changed @${now.handle}: ${said.join("; ")}.`);
  }

  /** The caller, when it may change the Team: the Lead in its own chat, or a session of the person's. */
  private caller(ctx: ProviderCallContext, what: string, nothing: string): Caller | { error: CallToolResult } {
    let session: Session;
    try { session = this.d.sessions.get(ctx.sessionId); } catch { return { error: err("the calling session no longer exists.") }; }
    const me = this.d.team.teammateOf(session.id);
    if (!me) return { session, lead: null, held: session.permissionMode };
    if (me.archived || !me.lead || me.homeSessionId !== session.id || me.spaceId !== session.spaceId) {
      const who = `you are @${me.handle}${me.lead ? ", in a task session rather than your own chat" : ", not the Lead"}`;
      return { error: err(`refused: only the space's Lead, in its own chat, or one of the person's own sessions can ${what}, and ${who}. ${nothing}`) };
    }
    return { session, lead: me, held: rank(session.permissionMode) < rank(me.permissionMode) ? session.permissionMode : me.permissionMode };
  }

  private personTurn(caller: Caller, words: Omit<AgentWriteRule, "where">): CallToolResult | null {
    return refuseUnlessPersonTurn({ sessions: this.d.sessions, turnOrigin: (id) => this.d.team.turnOrigin(id) }, caller.session.id, { ...words, where: caller.lead ? "your chat" : "this chat" });
  }

  /** The refusal when `mode` is more access than the caller has. */
  private capped(caller: Caller, mode: string, whom: string, nothing: string): CallToolResult | null {
    if (rank(mode) <= rank(caller.held)) return null;
    return err(`refused: you are on ${modeLabel(caller.held)}, and nobody can give more access than they have. Ask for ${modeLabel(caller.held)} or less, or the person can set ${whom} to ${modeLabel(mode)} themselves. ${nothing}`);
  }

  /** What of the teammate's model and effort the change lowers, or could lower: anything not plainly a step up. */
  private lowered(cur: Teammate, change: { agentKind?: AgentKind; model?: string | null; effort?: string | null }): string[] {
    const out: string[] = [];
    const kind = change.agentKind ?? cur.agentKind;
    const model = change.model !== undefined ? change.model : change.agentKind !== undefined ? null : cur.model;
    if (kind !== cur.agentKind || model !== cur.model) {
      const order = this.modelOrder(kind);
      const was = cur.agentKind === kind ? order.indexOf(this.resolved(cur.agentKind, cur.model)) : -1;
      const next = order.indexOf(this.resolved(kind, model));
      if (was < 0 || next < 0 || next > was || (next === was && kind !== cur.agentKind)) out.push("model");
    }
    if (change.effort !== undefined && change.effort !== cur.effort) {
      const was = cur.effort ? EFFORT_LEVELS.indexOf(cur.effort as never) : -1;
      const next = change.effort ? EFFORT_LEVELS.indexOf(change.effort as never) : -1;
      if (was < 0 || next < 0 || next < was) out.push("effort");
    }
    return out;
  }

  /** The kind's models, best first: what its CLI says it has, or Realm's own list. */
  private modelOrder(kind: AgentKind): string[] {
    const live = this.probes().find((p) => p.kind === kind)?.models ?? [];
    return (live.length > 0 ? live : AGENT_MODELS[kind]).map((m) => m.id);
  }

  /** The model a teammate runs: its own, or the one its CLI says it runs when none is picked. */
  private resolved(kind: AgentKind, model: string | null): string {
    return model ?? this.probes().find((p) => p.kind === kind)?.models?.find((m) => m.isDefault)?.id ?? "";
  }

  private probes(): ProbeResult[] { return this.d.sessions.probeCached()?.rows ?? []; }
}

/** The change in words, from what it was to what it will be: "model Claude Opus 5.5 → Claude Sonnet 5.5". */
function describe(cur: Teammate, change: Record<string, unknown>, probes: ProbeResult[]): string[] {
  const out: string[] = [];
  const kind = (change.agentKind as AgentKind | undefined) ?? cur.agentKind;
  if (change.agentKind !== undefined || change.model !== undefined) {
    const model = change.model !== undefined ? (change.model as string | null) : null;
    out.push(`model ${modelNameOf(cur.agentKind, cur.model, probes)} → ${modelNameOf(kind, model, probes)}`);
  }
  if (change.effort !== undefined) out.push(`effort ${cur.effort ?? "default"} → ${(change.effort as string | null) ?? "default"}`);
  if (change.permissionMode !== undefined) out.push(`access ${modeLabel(cur.permissionMode)} → ${modeLabel(change.permissionMode as string)}`);
  if (change.name !== undefined) out.push(`name "${cur.name}" → "${String(change.name)}"`);
  if (change.handle !== undefined) out.push(`handle @${cur.handle} → @${normalizeHandle(String(change.handle))}`);
  if (change.brief !== undefined) out.push("its brief");
  if (change.folder !== undefined) out.push(`folder ${cur.folder} → ${(change.folder as string | null) ?? "the space's folder"}`);
  if (change.group !== undefined) out.push(`group ${cur.group ? `"${cur.group}"` : "none"} → ${change.group ? `"${String(change.group)}"` : "none"}`);
  if (change.lead !== undefined) out.push(change.lead ? "make it the Lead" : "no longer the Lead");
  if (change.icon !== undefined) out.push("its icon");
  if (change.schedule !== undefined) out.push(change.schedule === null ? "remove its clock" : `its clock${(change.schedule as { cron?: string }).cron ? ` ("${(change.schedule as { cron?: string }).cron}")` : ""}`);
  return out;
}
