import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  AGENT_MODELS, EFFORT_LEVELS, TeammateArchiveArgsSchema, TeammateCreateArgsSchema, TeammateGetArgsSchema, TeammateReorderArgsSchema,
  TeammateSetLeadArgsSchema, TeammateUpdateArgsSchema, normalizeHandle, teammateByHandle,
  type AgentKind, type Session, type Teammate, type UpdateTeammateInput,
} from "@realm/contracts";
import type { ProbeResult } from "@realm/adapters";
import type { BrowserPermissionBroker } from "../browsers/permissions";
import { modeLabel, rank } from "../delegation/dispatch";
import { askCard, refuseUnlessPersonTurn, type AgentWriteRule } from "../mcp/agent-gate";
import type { ProviderCallContext } from "../mcp/gateway";
import { err, ok, parseArgs } from "../mcp/tool-result";
import { modelNameOf } from "../sessions/handover";
import type { ScheduleService } from "../schedules/service";
import { RpcError } from "../store/rows";
import { pickFolder } from "../workspace/spaces";
import type { TeammatesService } from "./service";

/**
 * The tools that change the Team itself: `teammate_create`, `teammate_update`, `teammate_archive`,
 * `teammate_set_lead`, `teammate_reorder` and `teammate_run_clock`. They wrap the service methods the
 * Add a teammate and Edit sheets, the Team list and a teammate's Run now call, behind the gates every
 * agent write to Realm keeps:
 *
 * - the caller is the space's Lead in its own chat, or a session of the person's (not a teammate's
 *   task session, nor another teammate's chat);
 * - the person started this turn (`refuseUnlessPersonTurn`);
 * - no teammate is put on more access than the caller has (`rank`, as `team_set_access`);
 * - a folder is taken the way `space_create` takes one (`pickFolder`);
 * - a card, unless the caller is on Full access; and a card that shows even on Full access when the
 *   change lowers a teammate's model or effort, saying from what to what, or hands over the Lead.
 *   Reordering the Team list is cosmetic and asks no card.
 */
export type TeamManageDeps = {
  team: Pick<TeammatesService, "create" | "update" | "archive" | "setLead" | "reorder" | "get" | "list" | "turnOrigin" | "teammateOf">;
  schedules: Pick<ScheduleService, "runNow">;
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
    const said = changeWords(target, { ...change, ...(folder !== undefined ? { folder } : {}) }, this.probes());
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

  /** `teammate_archive`: off the Team list and out of the tools, or back on it. Its sessions stay. */
  async archive(ctx: ProviderCallContext, raw: unknown): Promise<CallToolResult> {
    const a = parseArgs(TeammateArchiveArgsSchema, raw); if ("error" in a) return a.error;
    const archived = a.value.archived ?? true;
    const nothing = "Nothing changed.";
    const caller = this.caller(ctx, archived ? "archive a teammate" : "bring a teammate back", nothing); if ("error" in caller) return caller.error;
    const turn = this.personTurn(caller, { rule: archived ? "Teammates are archived" : "Teammates are brought back", nothing }); if (turn) return turn;
    const target = this.find(caller.session.spaceId, a.value.to, true, nothing); if ("error" in target) return target.error;
    if (target.archived === archived) return ok(`@${target.handle} is already ${archived ? "archived" : "on the Team list"}. ${nothing}`);
    const title = archived
      ? `Archive @${target.handle} (${target.name}): it leaves the Team list and the team tools${target.lead ? ", and the space has no Lead until you pick one" : ""}${target.schedule?.enabled ? ", and its clock stops" : ""}. Its sessions stay.`
      : `Bring @${target.handle} (${target.name}) back onto the Team list`;
    const denied = await askCard(this.d.broker, ctx.sessionId, { toolKey: "teammate_archive", title, input: { to: target.handle, archived } });
    if (denied) return denied;
    const now = this.d.team.archive(target.id, archived);
    return ok(archived
      ? `Archived @${now.handle}. Its sessions stay; teammate_archive with archived: false brings it back.`
      : `@${now.handle} is back on the Team list${now.handle !== target.handle ? ` (as @${now.handle}: @${target.handle} was taken while it was away)` : ""}.`);
  }

  /** `teammate_set_lead`: make a teammate the space's Lead, or leave the space with none. Always on a card. */
  async setLead(ctx: ProviderCallContext, raw: unknown): Promise<CallToolResult> {
    const a = parseArgs(TeammateSetLeadArgsSchema, raw); if ("error" in a) return a.error;
    const nothing = "Nothing changed.";
    const caller = this.caller(ctx, "choose the Lead", nothing); if ("error" in caller) return caller.error;
    const turn = this.personTurn(caller, { rule: "The Lead is chosen", nothing }); if (turn) return turn;
    const spaceId = caller.session.spaceId;
    const current = this.d.team.list(spaceId).find((t) => t.lead) ?? null;
    const target = a.value.to === null ? null : this.find(spaceId, a.value.to, false, nothing);
    if (target && "error" in target) return target.error;
    if (target?.id === current?.id) return ok(`${target ? `@${target.handle} is already the Lead` : "The space already has no Lead"}. ${nothing}`);
    const title = target
      ? `Make @${target.handle} (${target.name}) the Lead${current ? `, in place of @${current.handle}` : ""}`
      : `Leave the space with no Lead (@${current!.handle} stops being the Lead)`;
    const denied = await askCard(this.d.broker, ctx.sessionId, { toolKey: "teammate_set_lead", title, input: { to: target?.handle ?? null }, always: true });
    if (denied) return denied;
    this.d.team.setLead(spaceId, target?.id ?? null);
    return ok(target ? `@${target.handle} is the Lead now${current ? `; @${current.handle} is not` : ""}.` : `The space has no Lead now; @${current!.handle} is not.`);
  }

  /** `teammate_reorder`: the Team list's order and sections, every teammate on it, top to bottom. No card: it is cosmetic. */
  async reorder(ctx: ProviderCallContext, raw: unknown): Promise<CallToolResult> {
    const a = parseArgs(TeammateReorderArgsSchema, raw); if ("error" in a) return a.error;
    const nothing = "Nothing changed.";
    const caller = this.caller(ctx, "reorder the Team list", nothing); if ("error" in caller) return caller.error;
    const turn = this.personTurn(caller, { rule: "The Team list is reordered", nothing }); if (turn) return turn;
    const listed = this.d.team.list(caller.session.spaceId);
    const order: { id: string; group: string | null }[] = [];
    for (const o of a.value.order) {
      const t = teammateByHandle(listed, o.handle);
      if (!t) return err(`there is no @${normalizeHandle(o.handle)} on the Team list. ${nothing}`);
      if (order.some((x) => x.id === t.id)) return err(`@${t.handle} is named twice. ${nothing}`);
      order.push({ id: t.id, group: o.group ?? null });
    }
    const missing = listed.filter((t) => !order.some((o) => o.id === t.id));
    if (missing.length > 0) return err(`name every teammate on the Team list, top to bottom; missing: ${missing.map((t) => `@${t.handle}`).join(", ")}. ${nothing}`);
    const now = this.d.team.reorder({ spaceId: caller.session.spaceId, order });
    return ok(`The Team list is now: ${now.map((t) => `@${t.handle}${t.group ? ` (${t.group})` : ""}`).join(", ")}.`);
  }

  /** `teammate_run_clock`: fire a teammate's clock now, as Run now on its page does. */
  async runClock(ctx: ProviderCallContext, raw: unknown): Promise<CallToolResult> {
    const a = parseArgs(TeammateGetArgsSchema, raw); if ("error" in a) return a.error;
    const nothing = "Nothing ran.";
    const caller = this.caller(ctx, "run a teammate's clock", nothing); if ("error" in caller) return caller.error;
    const turn = this.personTurn(caller, { rule: "Clocks are run by hand", nothing }); if (turn) return turn;
    const target = this.find(caller.session.spaceId, a.value.to, false, nothing); if ("error" in target) return target.error;
    if (!target.schedule) return err(`@${target.handle} has no clock. teammate_update with schedule gives it one. ${nothing}`);
    const denied = await askCard(this.d.broker, ctx.sessionId, { toolKey: "teammate_run_clock", title: `Run @${target.handle}'s clock now: "${target.schedule.prompt}" in its chat`, input: { to: target.handle } });
    if (denied) return denied;
    try { this.d.schedules.runNow(target.schedule.id); } catch (e) { return err(`${e instanceof RpcError ? e.message : String(e)}. ${nothing}`); }
    return ok(`@${target.handle}'s clock ran: its prompt is a turn in its chat, session ${this.d.team.get(target.id).homeSessionId}. teammate_sessions shows the task sessions it starts.`);
  }

  /** `to` on the Team list, or among the archived too when `archived`. */
  private find(spaceId: string, to: string, archived: boolean, nothing: string): Teammate | { error: CallToolResult } {
    const listed = this.d.team.list(spaceId);
    const t = teammateByHandle(archived ? [...listed, ...this.d.team.list(spaceId, true)] : listed, to);
    if (t) return t;
    return { error: err(`there is no @${normalizeHandle(to)} here. Teammates here: ${listed.map((x) => `@${x.handle}`).join(", ") || "none"}. ${nothing}`) };
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
      const was = cur.effort ? (EFFORT_LEVELS as readonly string[]).indexOf(cur.effort) : -1;
      const next = change.effort ? (EFFORT_LEVELS as readonly string[]).indexOf(change.effort) : -1;
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
function changeWords(cur: Teammate, change: Omit<UpdateTeammateInput, "id">, probes: ProbeResult[]): string[] {
  const out: string[] = [];
  const kind = change.agentKind ?? cur.agentKind;
  if (change.agentKind !== undefined || change.model !== undefined) {
    out.push(`model ${modelNameOf(cur.agentKind, cur.model, probes)} → ${modelNameOf(kind, change.model ?? null, probes)}`);
  }
  if (change.effort !== undefined) out.push(`effort ${cur.effort ?? "default"} → ${change.effort ?? "default"}`);
  if (change.permissionMode !== undefined) out.push(`access ${modeLabel(cur.permissionMode)} → ${modeLabel(change.permissionMode)}`);
  if (change.name !== undefined) out.push(`name "${cur.name}" → "${change.name}"`);
  if (change.handle !== undefined) out.push(`handle @${cur.handle} → @${normalizeHandle(change.handle)}`);
  if (change.brief !== undefined) out.push("its brief");
  if (change.folder !== undefined) out.push(`folder ${cur.folder} → ${change.folder ?? "the space's folder"}`);
  if (change.group !== undefined) out.push(`group ${cur.group ? `"${cur.group}"` : "none"} → ${change.group ? `"${change.group}"` : "none"}`);
  if (change.lead !== undefined) out.push(change.lead ? "make it the Lead" : "no longer the Lead");
  if (change.icon !== undefined) out.push("its icon");
  if (change.schedule !== undefined) out.push(change.schedule === null ? "remove its clock" : `its clock${change.schedule.cron ? ` ("${change.schedule.cron}")` : ""}`);
  return out;
}
