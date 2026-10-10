import { PLAN_LIMIT_REPORTING, mergeWindows, type AgentKind, type PlanLimits, type SessionEventPayload } from "@realm/contracts";
import type { RpcServer } from "../rpc/server";

/**
 * What each provider says about the account's plan quota.
 *
 * Keyed by ACCOUNT, not by session, and that is the whole design: a rate limit belongs to the
 * account behind a session, so two sessions on one account running side by side are looking at one
 * number. Folding per-session readings into per-account state is what stops the panel from showing
 * the same window twice with different values because one session heard about it later.
 *
 * Every agent but Claude has one account, so its kind is the whole key. Claude Code keeps a sign-in
 * per config folder and a profile can name its own, so Claude's key is the kind and the folder. The
 * folder is `home` throughout, and null is the default one. Two folders under one key would let a
 * work account's reading move a personal account's bars, lend it a plan tier, and clear a warning
 * it is still under.
 *
 * In memory, like the mid-turn queue and for a weaker version of the same reason: a quota reading is
 * only true for the moment it was taken. A figure restored from disk at boot would be presented as
 * current when nobody has asked the provider since the last run, and "78% as of some point
 * yesterday" is worse than an honest "run a session and this will fill in".
 */
export class PlanLimitsService {
  /** Each kind's rows by config folder, null being the default one. Every kind but Claude keeps
   *  its one row there. */
  private byAccount = new Map<AgentKind, Map<string | null, PlanLimits>>();

  constructor(private d: { rpc: RpcServer }) {}

  /**
   * Fold one adapter reading into the kind's state.
   *
   * `home` is the Claude config folder the reporting session runs under, null for the default one,
   * and a Claude reading touches that folder's row alone. Every other kind ignores it, since no
   * other agent has a second account and a second Codex row would be one account drawn twice.
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
  apply(kind: AgentKind, reading: SessionEventPayload<"rate_limit">, home: string | null = null, now = Date.now()): void {
    const perFolder = kind === "claude";
    const folder = perFolder ? home : null;
    const rows = this.byAccount.get(kind) ?? new Map<string | null, PlanLimits>();
    const prior = rows.get(folder);
    rows.set(folder, {
      agentKind: kind,
      subscriptionType: reading.subscriptionType ?? prior?.subscriptionType ?? null,
      organization: reading.organization ?? prior?.organization ?? null,
      windows: mergeWindows(prior?.windows ?? [], reading.windows),
      alert: reading.alert,
      alertWindow: reading.alertWindow,
      unavailable: reading.unavailable,
      detail: reading.detail,
      ts: now,
      ...(perFolder ? { home } : {}),
    });
    this.byAccount.set(kind, rows);
    this.d.rpc.broadcast("limits.changed", { limits: this.list() });
  }

  /**
   * Every kind's state, including the kinds that have nothing to say.
   *
   * A row for a silent kind is the point: the panel has to distinguish "Cursor cannot report this"
   * from "Cursor is fine", and only a row carrying `unsupported` does that. `not-yet-known` is the
   * other half — a kind that reports but has not run, which is a waiting state rather than a refusal.
   *
   * A kind that has reported answers with its own rows, in the order `reported` gives them, and
   * never with the waiting row as well. That row is for a kind with no row at all, and it is the
   * row this list always gave, with no `home` on it. Kept beside a named folder's row, it would
   * tell the person to run a Claude session when one has just run.
   */
  list(): PlanLimits[] {
    return (Object.keys(PLAN_LIMIT_REPORTING) as AgentKind[]).flatMap((kind) => this.reported(kind) ?? [{
      agentKind: kind,
      subscriptionType: null,
      organization: null,
      windows: [],
      alert: "none" as const,
      alertWindow: null,
      unavailable: PLAN_LIMIT_REPORTING[kind].source === "none" ? ("unsupported" as const) : ("not-yet-known" as const),
      detail: null,
      ts: 0,
    }]);
  }

  /**
   * The rows a kind has reported, or null where it has reported nothing.
   *
   * For Claude that is a row per config folder. The default folder's comes first, being the one
   * every profile runs under until it names its own. The named folders follow in the order each
   * first reported, so a card in the panel keeps its place whichever session speaks next.
   */
  private reported(kind: AgentKind): PlanLimits[] | null {
    const rows = this.byAccount.get(kind);
    if (!rows) return null;
    const first = rows.get(null);
    const named = [...rows].filter(([folder]) => folder !== null).map(([, row]) => row);
    return first ? [first, ...named] : named;
  }
}
