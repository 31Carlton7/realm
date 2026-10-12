import { codexRateLimitsReading } from "@realm/adapters";
import { PLAN_LIMIT_REPORTING, PlanLimitsSchema, mergeWindows, type AgentKind, type PlanLimits, type SessionEventPayload } from "@realm/contracts";
import type { RpcServer } from "../rpc/server";
import type { SettingsStore } from "../store/settings";
import { latestCodexRateLimits } from "./codex-rollout";

/** `settings` row holding the last reading per kind. Generic table, so no migration. */
export const PLAN_LIMITS_KEY = "limits.last";

/**
 * What each provider says about the account's plan quota.
 *
 * Keyed by AGENT KIND, not by session, and that is the whole design: a rate limit belongs to the
 * account behind every session of that kind, so two Claude sessions running side by side are looking
 * at one number. Folding per-session readings into per-kind state is what stops the panel from
 * showing the same window twice with different values because one session heard about it later.
 *
 * The last reading is KEPT, with the time it was taken. It used to live in memory only, on the
 * argument that a figure restored at boot would be presented as current — and so after every launch
 * the one question the page exists for, "how much is left", had no answer until a session happened
 * to run. The reading carries its `ts` and every window its `resetsAt`, so the panel can say "as of
 * 40 minutes ago" and can tell a window that has since reset from one that has not; that is a stale
 * figure presented honestly, which beats no figure.
 *
 * Codex is also read from its own rollouts on disk (`latestCodexRateLimits`), which costs nothing and
 * covers Codex run outside Realm. Claude has no such file; its reading comes from sessions only.
 */
export class PlanLimitsService {
  private byKind = new Map<AgentKind, PlanLimits>();

  constructor(private d: { rpc: RpcServer; settings?: SettingsStore; codexHome?: string }) {
    for (const row of restore(d.settings?.get(PLAN_LIMITS_KEY))) this.byKind.set(row.agentKind as AgentKind, row);
  }

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
    this.d.settings?.set(PLAN_LIMITS_KEY, [...this.byKind.values()]);
    this.d.rpc.broadcast("limits.changed", { limits: this.list() });
  }

  /**
   * Catch up on what Codex wrote to disk since the last reading. Only a NEWER reading is taken: the
   * rollout of a session Realm itself ran repeats what the app-server already pushed, and an older
   * one must never roll a fresher bar back.
   */
  async readLocal(): Promise<void> {
    if (!this.d.codexHome) return;
    const found = await latestCodexRateLimits(this.d.codexHome).catch(() => null);
    if (!found || found.ts <= (this.byKind.get("codex")?.ts ?? 0)) return;
    const reading = codexRateLimitsReading(found.rateLimits);
    if (reading && reading.windows.length > 0) this.apply("codex", reading, found.ts);
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

/** A stored list, parsed row by row: the settings table is user-editable JSON, and one bad row must
 *  not cost the others. A kind this build does not know is dropped, as the usage page drops one. */
function restore(raw: unknown): PlanLimits[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r) => {
    const p = PlanLimitsSchema.safeParse(r);
    return p.success && p.data.agentKind in PLAN_LIMIT_REPORTING ? [p.data] : [];
  });
}
