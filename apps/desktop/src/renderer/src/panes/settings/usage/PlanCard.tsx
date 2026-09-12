import {
  AGENT_META, planLabel, planUnavailableNote, reportsPlanLimits, windowsByUrgency,
  type AgentKind, type PlanLimits, type PlanWindow,
} from "@realm/contracts";
import { useApp } from "../../../state/store";
import { whenLabel } from "../../schedules/SchedulesPage";

/**
 * Settings → Usage → Plan & limits: which plan each connected account is on, and how much of its
 * quota is left.
 *
 * A different question from everything else on this page, which is why it is its own card: the rest
 * of Usage counts what REALM watched go past (tokens on the wire, dollars from a catalog) and can
 * answer for any agent. This card reports what the PROVIDER says about an account, which cannot be
 * derived from anything Realm sees and which most agents will not say at all.
 *
 * The honesty rule that shapes it: a window with no number is never drawn as an empty bar, and a
 * provider that cannot report is never drawn as a provider at 0%. Both would read as "you have plenty
 * left" — the single most expensive wrong thing this card could say.
 */

/** One window's bar. Its own meter rather than `BudgetMeter`: that one derives a warn state from
 *  `spent/budget >= 0.8`, and the whole point here is that the PROVIDER owns the verdict — a bar that
 *  turned amber on Realm's arithmetic would contradict the row above it. */
function WindowRow({ window: w, alerted }: { window: PlanWindow; alerted: boolean }) {
  const pct = w.utilization;
  return (
    <div className="plan-window" data-alerted={alerted || undefined}>
      <span className="plan-window-label">{w.label}</span>
      {pct === null ? (
        // The provider named the window and not its utilization. Saying so beats a 0% bar, which
        // would be a number Realm made up about a limit it cannot see.
        <span className="plan-window-unknown">not reported</span>
      ) : (
        <div className="plan-track" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}
          aria-label={`${w.label} window`}>
          <div className="plan-fill" style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
        </div>
      )}
      {pct !== null && <span className="plan-window-pct">{Math.round(pct)}%</span>}
      <span className="plan-window-reset">{w.resetsAt === null ? "" : `resets ${whenLabel(w.resetsAt)}`}</span>
    </div>
  );
}

function AccountCard({ row }: { row: PlanLimits }) {
  const kind = row.agentKind as AgentKind;
  const plan = planLabel(kind, row.subscriptionType);
  return (
    <section className="plan-account" data-alert={row.alert === "none" ? undefined : row.alert}>
      <header className="plan-account-head">
        <span className="plan-account-name">{AGENT_META[kind].label}</span>
        {/* The tier, and the organization when there is one: a team seat at a given tier is a
            different thing to explain than a personal plan at the same tier. */}
        <span className="plan-account-tier">{plan ?? "plan not reported"}</span>
        {row.organization && <span className="plan-account-org">{row.organization}</span>}
      </header>
      {row.unavailable ? (
        <p className="plan-note">{planUnavailableNote(kind, row.unavailable)}{row.detail ? ` (${row.detail})` : ""}</p>
      ) : row.windows.length === 0 ? (
        <p className="plan-note">{planUnavailableNote(kind, "not-yet-known")}</p>
      ) : (
        // Fullest first: the question is "what stops me next", and that is whichever window is
        // closest to its ceiling, not whichever one the wire happened to list first.
        windowsByUrgency(row.windows).map((w) => (
          <WindowRow key={w.id} window={w} alerted={row.alertWindow === w.id} />
        ))
      )}
    </section>
  );
}

export function PlanCard() {
  const limits = useApp((s) => s.planLimits);

  const reporting = limits.filter((r) => reportsPlanLimits(r.agentKind as AgentKind));
  const silent = limits.filter((r) => !reportsPlanLimits(r.agentKind as AgentKind));

  return (
    <section className="settings-card plan-card" aria-labelledby="plan-card-head">
      <h3 className="settings-head" id="plan-card-head">Plan &amp; limits</h3>
      {reporting.map((row) => <AccountCard key={row.agentKind} row={row} />)}
      {/* One line for every agent that cannot answer, rather than a row each. Twelve stacked
          "does not report plan limits" rows would be the tiny grey copy this app's guidelines reject,
          and the fact is the same for all of them — their protocols have no notion of a plan. */}
      {silent.length > 0 && (
        <p className="plan-note plan-note-silent">
          No plan limits from {silent.map((r) => AGENT_META[r.agentKind as AgentKind].label).join(", ")} — their
          protocols do not report one.
        </p>
      )}
    </section>
  );
}
