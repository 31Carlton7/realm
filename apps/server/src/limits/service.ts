import { PLAN_LIMIT_REPORTING, mergeWindows, type AgentKind, type PlanLimits, type SessionEventPayload } from "@realm/contracts";
import type { RpcServer } from "../rpc/server";

/**
 * What each provider says about the account's plan quota.
 *
 * Keyed by AGENT KIND, not by session, and that is the whole design: a rate limit belongs to the
 * account behind every session of that kind, so two Claude sessions running side by side are looking
 * at one number. Folding per-session readings into per-kind state is what stops the panel from
 * showing the same window twice with different values because one session heard about it later.
 *
 * In memory, like the mid-turn queue and for a weaker version of the same reason: a quota reading is
 * only true for the moment it was taken. A figure restored from disk at boot would be presented as
 * current when nobody has asked the provider since the last run, and "78% as of some point
 * yesterday" is worse than an honest "run a session and this will fill in".
 */
export class PlanLimitsService {
  private byKind = new Map<AgentKind, PlanLimits>();

  constructor(private d: { rpc: RpcServer }) {}

  /**
   * Fold one adapter reading into the kind's state.
   *
   * Windows are MERGED rather than replaced (`mergeWindows`): the two things an adapter can report
   * carry different amounts — a full control-request answer lists every window, a stream event names
   * only the one that moved — and replacing wholesale would blank four windows every time the fifth
   * changed.
   *
   * The scalars replace, because each is the newest thing anybody knows: `alert` in particular must
   * be able to fall back to `none` when a provider stops warning, which an accumulate-only rule
   * would make impossible.
   */
  apply(kind: AgentKind, reading: SessionEventPayload<"rate_limit">, now = Date.now()): void {
    const prior = this.byKind.get(kind);
    this.byKind.set(kind, {
      agentKind: kind,
      subscriptionType: reading.subscriptionType ?? prior?.subscriptionType ?? null,
      organization: reading.organization ?? prior?.organization ?? null,
      windows: mergeWindows(prior?.windows ?? [], reading.windows),
      alert: reading.alert,
      alertWindow: reading.alertWindow,
      unavailable: reading.unavailable,
      detail: reading.detail,
      ts: now,
    });
    this.d.rpc.broadcast("limits.changed", { limits: this.list() });
  }

  /**
   * Every kind's state, including the kinds that have nothing to say.
   *
   * A row for a silent kind is the point: the panel has to distinguish "Cursor cannot report this"
   * from "Cursor is fine", and only a row carrying `unsupported` does that. `not-yet-known` is the
   * other half — a kind that reports but has not run, which is a waiting state rather than a refusal.
   */
  list(): PlanLimits[] {
    return (Object.keys(PLAN_LIMIT_REPORTING) as AgentKind[]).map((kind) => this.byKind.get(kind) ?? {
      agentKind: kind,
      subscriptionType: null,
      organization: null,
      windows: [],
      alert: "none" as const,
      alertWindow: null,
      unavailable: PLAN_LIMIT_REPORTING[kind].source === "none" ? ("unsupported" as const) : ("not-yet-known" as const),
      detail: null,
      ts: 0,
    });
  }
}
