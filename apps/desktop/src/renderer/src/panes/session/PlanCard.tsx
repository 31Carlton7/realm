import { Icon } from "@realm/ui";
import type { PermissionDecision } from "../../state/store";
import { Markdown } from "./Markdown";
import { TodoList } from "./rich/ToolViews";
import type { PendingPermission, PlanStep } from "./transcript-model";

/**
 * The plan the agent proposed, drawn as a plan.
 *
 * Two bodies rather than one, because the protocols send two different artifacts and neither can be
 * derived from the other (see the `plan` session event): prose renders as the markdown it is, a
 * checklist reuses `TodoList` — the same drawing TodoWrite already gets, and for the same reason,
 * since a plan with per-step status IS a to-do list. A plan carrying both draws both.
 */
export function PlanCard({ text, steps, enter = false }: { text?: string; steps?: PlanStep[]; enter?: boolean }) {
  return (
    <div className="plan-card" role="group" aria-label="Plan" data-enter={enter || undefined}>
      <div className="plan-head"><Icon name="plan" size={14} /><span>Plan</span></div>
      {steps && steps.length > 0 && <TodoList todos={steps.map((s) => ({ content: s.text, status: s.status, activeForm: null }))} />}
      {text && <Markdown text={text} className="plan-body" />}
    </div>
  );
}

/**
 * The decision on a plan, when the agent is waiting for one.
 *
 * `ExitPlanMode` reaches Realm on the permission channel like any other tool, and that channel is
 * load-bearing: answering it is how the session leaves Plan. What it is NOT is a permission —
 * "Allow / Allow always / Deny" on a plan asks the wrong question, and the generic card buried the
 * plan itself in a clipped one-line summary.
 *
 * So the plan is a block of its own (mapped off the same tool call, and it stays in the scrollback
 * after the decision), and this is only the answer to it: approve, or keep planning. There is no
 * "always" — a standing grant to leave Plan unasked is not a thing a user can mean.
 */
export const isPlanDecision = (p: PendingPermission): boolean => p.toolName === "ExitPlanMode";

export function PlanDecision({ onDecide, autoFocus = false, enter = false }: {
  onDecide: (d: PermissionDecision) => void; autoFocus?: boolean; enter?: boolean;
}) {
  return (
    <div className="plan-decision" role="group" aria-label="Plan approval" data-enter={enter || undefined}
      onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onDecide("deny"); } }}>
      <span className="plan-decision-ask">Ready to build this?</span>
      <div className="plan-decision-actions">
        <button type="button" className="plan-approve" autoFocus={autoFocus} onClick={() => onDecide("allow")}>Approve plan</button>
        <button type="button" className="plan-reject" onClick={() => onDecide("deny")}>Keep planning</button>
      </div>
    </div>
  );
}
