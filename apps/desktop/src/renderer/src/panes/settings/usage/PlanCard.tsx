import { useEffect, useState } from "react";
import {
  AGENT_META, SELECTABLE_AGENT_KINDS, currentAlert, formatSpan, planLabel, planUnavailableNote, reportsPlanLimits,
  windowHasReset, windowPace, windowsByUrgency,
  type AgentKind, type PlanAlert, type PlanLimits, type PlanWindow, type WindowPace,
} from "@realm/contracts";
import { useApp } from "../../../state/store";
import { whenLabel } from "../../schedules/schedule-model";

/**
 * Settings ▸ Usage ▸ Plan limits: how much of each plan is left, and when it comes back.
 *
 * The page leads with this because it is the question a person opens Usage to ask. Everything else on
 * the page counts what REALM watched go past; this reports what the PROVIDER says about the account,
 * which nothing Realm sees can derive and most engines will not say at all.
 *
 * Honesty rules that shape it:
 *
 * - A window with no number is never drawn as an empty bar, and a provider that cannot report is never
 *   drawn at 0%. Both would read as "plenty left" — the most expensive wrong thing this could say.
 * - The reading is kept across launches (`PlanLimitsService`), so its age is stated, and a window
 *   whose reset time has passed since is drawn as reset, not at the figure it had before.
 * - The tone comes from the provider's verdict (`alert`), never from a threshold picked here. Pace is
 *   arithmetic on the provider's own numbers and the clock, and is worded as such.
 * - Every number is in words beside the bar and in the meter's accessible value; colour adds nothing
 *   a reader needs.
 */

/** The clock, a minute at a time, so countdowns move while the page is open. */
export function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

const PACE_WORDS: Record<WindowPace, string> = {
  ahead: "ahead of pace",
  on: "on pace",
  under: "under pace",
};

/** "Resets in 1h 12m (Today at 4:30 PM)" — the countdown first, because that is the actionable half. */
export function resetPhrase(w: PlanWindow, now: number): string | null {
  if (w.resetsAt === null) return null;
  if (w.resetsAt <= now) return `Reset ${lower(whenLabel(w.resetsAt, now))}`;
  return `Resets in ${formatSpan(w.resetsAt - now)} · ${whenLabel(w.resetsAt, now)}`;
}

const lower = (s: string) => (/^(Today|Tomorrow|Yesterday)\b/.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s);

/** How old a reading is, in the words a person uses. Null for one taken within the last minute. */
export function readingAge(ts: number, now: number): string | null {
  if (ts <= 0) return null;
  const ms = now - ts;
  if (ms < 90_000) return null;
  return `as of ${formatSpan(ms)} ago`;
}

function WindowRow({ window: w, alert, now }: { window: PlanWindow; alert: PlanAlert | null; now: number }) {
  const reset = windowHasReset(w, now);
  const used = w.utilization === null ? null : Math.max(0, Math.min(100, w.utilization));
  const pace = reset ? null : windowPace(w, now);
  const when = resetPhrase(w, now);
  const left = used === null ? null : Math.round(100 - used);

  return (
    <div className="plan-window" data-alert={alert ?? undefined} data-reset={reset || undefined}>
      <div className="plan-window-head">
        <span className="plan-window-label">{w.label}</span>
        <span className="plan-window-figure">
          {reset ? "reset since this reading"
            : used === null ? "not reported"
            : alert === "exceeded" ? "limit reached"
            : `${left}% left`}
        </span>
      </div>
      {!reset && used !== null && (
        <div className="plan-track" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(used)}
          aria-label={`${w.label} window`}
          aria-valuetext={`${Math.round(used)}% used, ${left}% left${when ? `. ${when}` : ""}${pace ? `, ${PACE_WORDS[pace.pace]}` : ""}`}>
          <div className="plan-fill" style={{ width: `${used}%` }} />
          {/* Where even spending would have the fill by now: the reader compares two positions on
              one bar rather than doing the arithmetic. A tick, not a fill, because it is not usage. */}
          {pace && <span className="plan-pace-tick" style={{ left: `${pace.elapsed * 100}%` }} aria-hidden="true" />}
        </div>
      )}
      <div className="plan-window-foot">
        {!reset && used !== null && <span className="plan-window-used">{Math.round(used)}% used</span>}
        {when && <span className="plan-window-reset">{when}</span>}
        {pace && <span className="plan-window-pace" data-pace={pace.pace} title="Compared with spending evenly across the window">{PACE_WORDS[pace.pace]}</span>}
      </div>
    </div>
  );
}

function AccountCard({ row, now }: { row: PlanLimits; now: number }) {
  const kind = row.agentKind as AgentKind;
  const plan = planLabel(kind, row.subscriptionType);
  const alert = currentAlert(row, now);
  const age = readingAge(row.ts, now);
  const windows = windowsByUrgency(row.windows);
  return (
    <section className="plan-account" data-alert={alert === "none" ? undefined : alert} aria-label={`${AGENT_META[kind].label} plan limits`}>
      <header className="plan-account-head">
        {/* The plan as a person says it ("Claude Max"), and the organization when there is one: a
            team seat at a given tier is a different thing to explain than a personal plan. */}
        <span className="plan-account-name">{plan ?? AGENT_META[kind].label}</span>
        {!plan && <span className="plan-account-tier">plan not reported</span>}
        {row.organization && <span className="plan-account-org">{row.organization}</span>}
        {age && !row.unavailable && windows.length > 0 && <span className="plan-account-age">{age}</span>}
      </header>
      {row.unavailable ? (
        <p className="plan-note">{planUnavailableNote(kind, row.unavailable)}{row.detail ? ` (${row.detail})` : ""}</p>
      ) : windows.length === 0 ? (
        <p className="plan-note">{planUnavailableNote(kind, "not-yet-known")}</p>
      ) : (
        <div className="plan-windows">
          {/* Fullest first: the question is "what stops me next", and that is whichever window is
              closest to its ceiling, not whichever one the wire happened to list first. Only the
              window the provider named carries its tone. */}
          {windows.map((w) => (
            <WindowRow key={w.id} window={w} now={now}
              alert={alert !== "none" && (row.alertWindow === w.id || row.alertWindow === null) ? alert : null} />
          ))}
        </div>
      )}
    </section>
  );
}

/** The kinds a person can actually run, as a set. `AgentKind` also carries `fake` — the harness the
 *  suite drives — and the service answers for every kind there is. */
const RUNNABLE = new Set<string>(SELECTABLE_AGENT_KINDS);

export function PlanCard() {
  const limits = useApp((s) => s.planLimits);
  const now = useMinuteClock();

  const rows = limits.filter((r) => RUNNABLE.has(r.agentKind));
  const reporting = rows.filter((r) => reportsPlanLimits(r.agentKind as AgentKind));
  const silent = rows.filter((r) => !reportsPlanLimits(r.agentKind as AgentKind));

  return (
    <section className="usage-section usage-plan" aria-labelledby="plan-card-head" data-setting="usage-plan">
      <header className="usage-section-head">
        <h2 id="plan-card-head">Plan limits</h2>
        <span className="usage-section-sub">What each provider says is left on your plan.</span>
      </header>
      <div className="plan-accounts">
        {reporting.map((row) => <AccountCard key={row.agentKind} row={row} now={now} />)}
      </div>
      {/* One line for every agent that cannot answer, rather than a row each: the fact is the same for
          all of them — their protocols have no notion of a plan. */}
      {silent.length > 0 && (
        <p className="plan-note plan-note-silent">
          No plan limits from {silent.map((r) => AGENT_META[r.agentKind as AgentKind].label).join(", ")} — their
          protocols do not report one.
        </p>
      )}
    </section>
  );
}
