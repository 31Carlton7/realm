import {
  bindsEverySession, isReadOnlyMode, resolvePolicy, tighterDecision,
  type PolicyCaps, type PolicyDecision, type RiskClass, type TeamPolicyRow, type ToolHints,
} from "@realm/contracts";
import type { GateOptions, GateResult } from "../../browsers/permissions";
import type { PoliciesService } from "./service";
import type { PolicyStore } from "./store";

/** One call as the gateway routed it. */
export type GatedCall = {
  /** `realm:<provider>` or `mcp:<server row id>`. */
  connector: string;
  tool: string;
  /** The name the agent called, for the card. */
  fullName: string;
  host?: string | null;
  annotations?: ToolHints | null;
  args: unknown;
};

export type GateAnswer =
  /** `answered`: the person has already said yes to this call — on the policy's own card, or by a sealed
   *  "without asking" row they pressed for it — so the ordinary gate inside the call need not ask again.
   *  False where only a floor let it through: whatever asks inside the call today still asks. */
  | { ok: true; answered: boolean }
  | { ok: false; message: string; summary: string };

export type PolicyGateDeps = {
  policies: Pick<PoliciesService, "isTeam" | "spaceName" | "rows" | "classify" | "connectorName">;
  store: Pick<PolicyStore, "autoCalls" | "lastAuto">;
  /** The role run a session works for — itself, or the lead it was delegated from — or null for the
   *  person's own sessions. */
  roleRunOf(sessionId: string): { roleId: string; runId: string | null; sessionId: string } | null;
  permissionMode(sessionId: string): string;
  broker: { gate(sessionId: string, toolKey: string, title: string, input: Record<string, unknown>, toolName: string, opts: GateOptions): Promise<GateResult> };
  log(spaceId: string, actor: string, verb: string, object: string | null, detail: Record<string, unknown>, run: { runId: string | null; sessionId: string } | null): void;
  now(): number;
};

const EXTERNAL: ReadonlySet<RiskClass> = new Set(["reversible-external", "irreversible-external"]);
const dayStart = (t: number): number => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

/** What a call of each class does, in the sentence a card or a refusal puts it in. */
const CLASS_ACTS: Record<RiskClass, string> = {
  read: "reads",
  "internal-write": "changes files and records in this space",
  "reversible-external": "changes something elsewhere",
  "irreversible-external": "does something that can't be taken back",
};

const toolWords = (tool: string): string => tool.replace(/[_-]+/g, " ").trim();

/**
 * The one gate at Realm's gateway (the dynamic-Teams plan, §4.5): every Realm tool and every MCP
 * server's tool a session in a team's space calls passes through `check` after routing and the
 * allowlist, and before the provider or `hub.call`.
 *
 * The verdict is the tightest of the team's rows (`resolvePolicy`) and, for a role run, its mode:
 *   - `block` and `ticket` refuse — for every session in the space, the person's own in any mode
 *     included (the owner's decision 1: the 10-07 night was the person's own Full-access session).
 *   - `ask` and `auto` bind role runs and what they delegate to. The person's own sessions keep their
 *     mode: their engine asks as it always has.
 *   - For a role run the engine's own MCP card is skipped (`decides`), so this is its one gate: a
 *     read-only mode refuses anything that is not a read, Default asks for it, and Accept edits leaves
 *     the rows to say. A "without asking" over its caps, or one carrying checks a direct call cannot
 *     meet, asks instead.
 * Every decision that is not a plain no-click within the space writes one line to the team's activity.
 */
export class PolicyGate {
  constructor(private d: PolicyGateDeps) {}

  /**
   * Whether this gate answers for the call, so the engine's own MCP approval card is skipped: always
   * for a role run in a team's space (one card, not two), and for the person's own session only where
   * the rows refuse — so a refusal comes without a card that could only be answered in vain.
   */
  async decides(sessionId: string, spaceId: string, route: Omit<GatedCall, "args" | "fullName"> | null): Promise<boolean> {
    if (!this.d.policies.isTeam(spaceId)) return false;
    if (this.d.roleRunOf(sessionId)) return true;
    if (!route) return false;
    return bindsEverySession((await this.verdict(spaceId, route)).decision);
  }

  async check(ctx: { sessionId: string; spaceId: string; fromView?: boolean }, call: GatedCall): Promise<GateAnswer> {
    const { sessionId, spaceId } = ctx;
    if (!this.d.policies.isTeam(spaceId)) return { ok: true, answered: false };
    const v = await this.verdict(spaceId, call);
    const role = ctx.fromView ? null : this.d.roleRunOf(sessionId);
    const actor = role ? `role:${role.roleId}` : "user";
    const run = role ? { runId: role.runId, sessionId: role.sessionId } : { runId: null, sessionId };
    const team = this.d.policies.spaceName(spaceId);
    const who = this.d.policies.connectorName(call.connector);
    const what = `${who}: ${toolWords(call.tool)}`;
    const detail = { connector: call.connector, tool: call.tool, class: v.class, verb: v.verb, rowId: v.row?.id ?? null, scope: v.row?.scope ?? "floor" };

    if (v.decision === "block") {
      this.d.log(spaceId, actor, "policy_blocked", what, detail, run);
      return { ok: false, summary: `blocked: ${team}'s policy says never`,
        message: `Refused: ${team}'s policy never lets ${what} run in this space. Nothing was done. Only the person can change this, on the team's Policies page.` };
    }
    if (v.decision === "ticket") {
      this.d.log(spaceId, actor, "policy_ticket", what, detail, run);
      return { ok: false, summary: `held: ${team}'s policy sends this through Review`,
        message: `Not run: ${team}'s policy has the person approve ${what} in Review and press it themselves. Propose it with review_submit — an item carrying the action — and nothing goes until they do.` };
    }
    // "Ask" and "without asking" bind role runs only; the person's own session keeps its mode.
    if (!role) return { ok: true, answered: false };

    const mode = this.d.permissionMode(sessionId);
    if (isReadOnlyMode(mode) && v.class !== "read") {
      this.d.log(spaceId, actor, "policy_refused", what, { ...detail, mode }, run);
      return { ok: false, summary: "blocked: a read-only mode", message: `Refused: this run is in a read-only mode, and ${what} ${CLASS_ACTS[v.class]}.` };
    }
    let decision: PolicyDecision = mode === "default" && v.class !== "read" ? tighterDecision(v.decision, "ask") : v.decision;
    let note: string | null = null;
    if (decision === "auto" && v.row && v.row.checks.length > 0) { decision = "ask"; note = "its checks are made in Review, so this direct call asks"; }
    if (decision === "auto" && EXTERNAL.has(v.class)) {
      const over = v.row ? this.overCaps(spaceId, v.row, v.verb) : "no limit is set";
      if (over) { decision = "ask"; note = over; }
      else this.d.log(spaceId, actor, "policy_auto", what, detail, run);
    }
    // Only a row the person sealed answers for them. A floor's "without asking" (reading, changing this
    // space) leaves the call exactly as it was: a Realm tool that asks inside its own handler still asks.
    if (decision === "auto") return { ok: true, answered: v.row !== null && v.row.sealed && v.row.decision === "auto" };

    const irreversible = v.class === "irreversible-external";
    const title = `${team}'s policy asks ${irreversible ? "each time " : ""}before ${who} ${CLASS_ACTS[v.class]}${note ? ` — ${note}` : ""}`;
    const input = call.args && typeof call.args === "object" && !Array.isArray(call.args) ? call.args as Record<string, unknown> : {};
    const answer = await this.d.broker.gate(sessionId, `policy:${call.connector}#${call.tool}`, title, input, call.fullName,
      irreversible ? { alwaysPrompt: true } : { promptUnderBypass: true, perSession: true });
    this.d.log(spaceId, actor, "policy_asked", what, { ...detail, allowed: answer.allowed, ...(note ? { note } : {}) }, run);
    if (!answer.allowed) return { ok: false, summary: "denied on the policy's card", message: `Not run: ${answer.reason}.` };
    return { ok: true, answered: true };
  }

  private async verdict(spaceId: string, call: Pick<GatedCall, "connector" | "tool" | "host" | "annotations">) {
    const [c, { rows }] = await Promise.all([this.d.policies.classify(spaceId, call), this.d.policies.rows(spaceId)]);
    return { ...resolvePolicy(rows, { connector: call.connector, tool: call.tool, class: c.class, verb: c.verb, asksFirst: c.asksFirst !== null }), class: c.class, verb: c.verb };
  }

  /** Why a no-click call is past its row's limits right now, in a card's words; null when it is not. */
  private overCaps(spaceId: string, row: TeamPolicyRow, verb: string): string | null {
    const caps: PolicyCaps = row.caps;
    const t = this.d.now();
    if (caps.window) {
      const h = new Date(t).getHours();
      if (h < caps.window.start || h >= caps.window.end) return "it is outside the hours this may go without asking";
    }
    if (caps.perDay !== undefined && this.d.store.autoCalls(spaceId, dayStart(t), { rowId: row.id, verb }).count >= caps.perDay) {
      return `today's ${caps.perDay} without asking are used`;
    }
    if (caps.gapMs !== undefined) {
      const last = this.d.store.lastAuto(spaceId, row.id, verb);
      if (last !== null && t - last < caps.gapMs) return "the last one went moments ago";
    }
    if (caps.teamPerDay !== undefined && this.d.store.autoCalls(spaceId, dayStart(t), { verb }).count >= caps.teamPerDay) {
      return `the team's ${caps.teamPerDay} for today are used`;
    }
    return null;
  }
}

